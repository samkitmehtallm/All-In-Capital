/**
 * Supabase adapter.
 *
 * Server-only. The service key bypasses RLS, which is exactly why it must never
 * reach the browser; the constructor refuses to run anywhere `window` exists, and
 * refuses to let a test run point at the live project.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  cosine,
  type Persisted,
  type Row,
  type Store,
  type VectorHit,
  type VectorQuery,
  type Where,
} from './store';

function resolveCredentials(): { url: string; serviceKey: string } {
  const isTest = process.env.NODE_ENV === 'test' || process.env.APP_ENV === 'test';

  const url = isTest ? process.env.SUPABASE_TEST_URL : process.env.SUPABASE_URL;
  const serviceKey = isTest
    ? process.env.SUPABASE_TEST_SERVICE_KEY
    : process.env.SUPABASE_SERVICE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      `Missing ${isTest ? 'SUPABASE_TEST_URL / SUPABASE_TEST_SERVICE_KEY' : 'SUPABASE_URL / SUPABASE_SERVICE_KEY'}. ` +
        'Test and live use separate databases.',
    );
  }

  // A test run that writes into the live project would be discovered the expensive
  // way, so it is refused here rather than reviewed later.
  if (isTest && process.env.SUPABASE_URL && url === process.env.SUPABASE_URL) {
    throw new Error('SUPABASE_TEST_URL points at the live project. Use a separate database for tests.');
  }

  return { url, serviceKey };
}

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseClient;

  constructor() {
    if (typeof globalThis.window !== 'undefined') {
      throw new Error('SupabaseStore holds the service key and must never be constructed in the browser.');
    }
    const { url, serviceKey } = resolveCredentials();
    this.client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private applyWhere(query: ReturnType<SupabaseClient['from']>['select'] extends never ? never : any, where?: Where) {
    let q = query;
    for (const [k, v] of Object.entries(where ?? {})) {
      q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    }
    return q;
  }

  async insert<T extends Row>(table: string, rows: T | T[]): Promise<Array<Persisted<T>>> {
    const { data, error } = await this.client.from(table).insert(rows as never).select();
    if (error) throw new Error(`insert ${table}: ${error.message}`);
    return (data ?? []) as Array<Persisted<T>>;
  }

  async upsert<T extends Row>(
    table: string,
    rows: T | T[],
    conflict: string[],
  ): Promise<Array<Persisted<T>>> {
    const { data, error } = await this.client
      .from(table)
      .upsert(rows as never, { onConflict: conflict.join(',') })
      .select();
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
    return (data ?? []) as Array<Persisted<T>>;
  }

  async update(table: string, where: Where, patch: Row): Promise<number> {
    const { data, error } = await this.applyWhere(
      this.client.from(table).update(patch as never),
      where,
    ).select();
    if (error) throw new Error(`update ${table}: ${error.message}`);
    return (data ?? []).length;
  }

  async select<T extends Row>(table: string, where?: Where): Promise<T[]> {
    const { data, error } = await this.applyWhere(this.client.from(table).select('*'), where);
    if (error) throw new Error(`select ${table}: ${error.message}`);
    return (data ?? []) as T[];
  }

  async selectOne<T extends Row>(table: string, where: Where): Promise<T | null> {
    const rows = await this.select<T>(table, where);
    return rows[0] ?? null;
  }

  async delete(table: string, where: Where): Promise<number> {
    const { data, error } = await this.applyWhere(this.client.from(table).delete(), where).select();
    if (error) throw new Error(`delete ${table}: ${error.message}`);
    return (data ?? []).length;
  }

  async count(table: string, where?: Where): Promise<number> {
    const { count, error } = await this.applyWhere(
      this.client.from(table).select('*', { count: 'exact', head: true }),
      where,
    );
    if (error) throw new Error(`count ${table}: ${error.message}`);
    return count ?? 0;
  }

  /**
   * Vector search.
   *
   * Uses the `match_<table>` RPC when one exists so the work happens in Postgres
   * against the HNSW index; falls back to fetching and scoring in process, which is
   * acceptable at portfolio and memo scale (18 and 12 rows) but is not how this
   * should run against a large table.
   */
  async nearest<T extends Row>(query: VectorQuery): Promise<Array<VectorHit<T>>> {
    const rpc = `match_${query.table}`;
    const { data, error } = await this.client.rpc(rpc, {
      query_embedding: query.embedding,
      match_count: query.limit,
    });

    if (!error && Array.isArray(data)) {
      return (data as Array<Row & { similarity: number }>).map((row) => ({
        row: row as unknown as T,
        similarity: Number(row.similarity ?? 0),
      }));
    }

    const rows = await this.select<T>(query.table, query.where);
    return rows
      .map((row) => {
        const vec = row[query.column];
        const parsed = typeof vec === 'string' ? (JSON.parse(vec) as number[]) : (vec as number[]);
        if (!Array.isArray(parsed)) return null;
        return { row, similarity: cosine(query.embedding, parsed) };
      })
      .filter((h): h is VectorHit<T> => h !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, query.limit);
  }

  // -- pgmq -----------------------------------------------------------------

  async enqueue(queue: string, message: Row): Promise<string> {
    const { data, error } = await this.client.schema('pgmq_public' as never).rpc('send', {
      queue_name: queue,
      message,
    });
    if (error) throw new Error(`enqueue ${queue}: ${error.message}`);
    return String(Array.isArray(data) ? data[0] : data);
  }

  async dequeue(queue: string, visibilityMs = 60_000): Promise<{ id: string; message: Row } | null> {
    const { data, error } = await this.client.schema('pgmq_public' as never).rpc('read', {
      queue_name: queue,
      sleep_seconds: Math.ceil(visibilityMs / 1000),
      n: 1,
    });
    if (error) throw new Error(`dequeue ${queue}: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return null;
    return { id: String(row.msg_id), message: row.message as Row };
  }

  async ack(queue: string, id: string): Promise<void> {
    const { error } = await this.client.schema('pgmq_public' as never).rpc('delete', {
      queue_name: queue,
      message_id: Number(id),
    });
    if (error) throw new Error(`ack ${queue}: ${error.message}`);
  }

  async queueDepth(queue: string): Promise<number> {
    const { data, error } = await this.client.rpc('pgmq_metrics', { queue_name: queue });
    if (error) return 0;
    const row = Array.isArray(data) ? data[0] : data;
    return Number((row as { queue_length?: number } | null)?.queue_length ?? 0);
  }
}
