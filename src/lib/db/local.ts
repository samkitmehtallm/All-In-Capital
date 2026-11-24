/**
 * Local store: one JSON file per table under `.data/`.
 *
 * Chosen over SQLite because `node:sqlite` still needs an experimental flag on
 * Node 22, and over an ORM because the Postgres schema is already the source of
 * truth. At ten applications and a few thousand rows the cost of a full-file read
 * is irrelevant, and being able to open a table in a text editor while debugging a
 * pipeline step is worth more than query planning.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  cosine,
  matches,
  type Persisted,
  type Row,
  type Store,
  type VectorHit,
  type VectorQuery,
  type Where,
} from './store';

interface QueueMessage {
  id: string;
  message: Row;
  visibleAt: number;
  enqueuedAt: number;
}

export class LocalStore implements Store {
  readonly kind = 'local' as const;
  private readonly dir: string;
  private readonly cache = new Map<string, Row[]>();

  constructor(dir = process.env.LOCAL_DATA_DIR ?? '.data') {
    this.dir = dir;
    mkdirSync(this.dir, { recursive: true });
  }

  private path(table: string): string {
    return join(this.dir, `${table}.json`);
  }

  private read(table: string): Row[] {
    const cached = this.cache.get(table);
    if (cached) return cached;
    const p = this.path(table);
    const rows: Row[] = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
    this.cache.set(table, rows);
    return rows;
  }

  private write(table: string, rows: Row[]): void {
    this.cache.set(table, rows);
    writeFileSync(this.path(table), JSON.stringify(rows, null, 2));
  }

  async insert<T extends Row>(table: string, rows: T | T[]): Promise<Array<Persisted<T>>> {
    const list = Array.isArray(rows) ? rows : [rows];
    const existing = this.read(table);
    const stamped = list.map((r) => ({
      id: r.id ?? randomUUID(),
      created_at: r.created_at ?? new Date().toISOString(),
      ...r,
    })) as Array<Persisted<T>>;
    this.write(table, [...existing, ...stamped]);
    return stamped;
  }

  async upsert<T extends Row>(
    table: string,
    rows: T | T[],
    conflict: string[],
  ): Promise<Array<Persisted<T>>> {
    const list = Array.isArray(rows) ? rows : [rows];
    const existing = this.read(table);
    const out: Array<Persisted<T>> = [];

    for (const row of list) {
      const key = Object.fromEntries(conflict.map((c) => [c, row[c]]));
      const idx = existing.findIndex((r) => matches(r, key));
      if (idx >= 0) {
        const merged = { ...existing[idx], ...row } as Persisted<T>;
        existing[idx] = merged;
        out.push(merged);
      } else {
        const stamped = {
          id: row.id ?? randomUUID(),
          created_at: row.created_at ?? new Date().toISOString(),
          ...row,
        } as Persisted<T>;
        existing.push(stamped);
        out.push(stamped);
      }
    }

    this.write(table, existing);
    return out;
  }

  async update(table: string, where: Where, patch: Row): Promise<number> {
    const rows = this.read(table);
    let n = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (matches(rows[i], where)) {
        rows[i] = { ...rows[i], ...patch };
        n += 1;
      }
    }
    if (n) this.write(table, rows);
    return n;
  }

  async select<T extends Row>(table: string, where?: Where): Promise<T[]> {
    return this.read(table).filter((r) => matches(r, where)) as T[];
  }

  async selectOne<T extends Row>(table: string, where: Where): Promise<T | null> {
    const found = this.read(table).find((r) => matches(r, where));
    return (found as T) ?? null;
  }

  async delete(table: string, where: Where): Promise<number> {
    const rows = this.read(table);
    const kept = rows.filter((r) => !matches(r, where));
    const removed = rows.length - kept.length;
    if (removed) this.write(table, kept);
    return removed;
  }

  async count(table: string, where?: Where): Promise<number> {
    return this.read(table).filter((r) => matches(r, where)).length;
  }

  async nearest<T extends Row>(query: VectorQuery): Promise<Array<VectorHit<T>>> {
    const rows = this.read(query.table).filter((r) => matches(r, query.where));
    const scored = rows
      .map((row) => {
        const vec = row[query.column];
        if (!Array.isArray(vec)) return null;
        return { row: row as T, similarity: cosine(query.embedding, vec as number[]) };
      })
      .filter((h): h is VectorHit<T> => h !== null);

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, query.limit);
  }

  // -- queue ----------------------------------------------------------------

  private queueTable(queue: string): string {
    return `_queue_${queue}`;
  }

  async enqueue(queue: string, message: Row): Promise<string> {
    const id = randomUUID();
    const rows = this.read(this.queueTable(queue));
    rows.push({ id, message, visibleAt: 0, enqueuedAt: Date.now() } satisfies QueueMessage as unknown as Row);
    this.write(this.queueTable(queue), rows);
    return id;
  }

  /**
   * Take the oldest visible message and hide it for `visibilityMs`.
   *
   * Matches pgmq's read-with-visibility-timeout semantics so a crashed worker
   * releases its message instead of losing it (brief §7: never lose an application).
   */
  async dequeue(queue: string, visibilityMs = 60_000): Promise<{ id: string; message: Row } | null> {
    const rows = this.read(this.queueTable(queue)) as unknown as QueueMessage[];
    const now = Date.now();
    const next = rows
      .filter((m) => m.visibleAt <= now)
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt)[0];
    if (!next) return null;
    next.visibleAt = now + visibilityMs;
    this.write(this.queueTable(queue), rows as unknown as Row[]);
    return { id: next.id, message: next.message };
  }

  async ack(queue: string, id: string): Promise<void> {
    await this.delete(this.queueTable(queue), { id });
  }

  async queueDepth(queue: string): Promise<number> {
    return this.count(this.queueTable(queue));
  }

  /** Test helper: forget everything in memory and on disk. */
  reset(): void {
    this.cache.clear();
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (f.endsWith('.json')) writeFileSync(join(this.dir, f), '[]');
    }
  }
}
