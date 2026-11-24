/**
 * Storage interface.
 *
 * One narrow interface with two adapters. The Postgres schema in supabase/migrations
 * is the source of truth for shape; the local adapter exists so the pipeline, the
 * tests and the 20-application volume test all run with no account and no network.
 *
 * The browser never touches either adapter: both are server-only, and the Supabase
 * one holds the service key (brief §2.8).
 */

export type Row = Record<string, unknown>;

/**
 * A row as it comes back from the store: whatever was written, plus the identity
 * the store assigned. Returning the bare input type instead would make `row.id`
 * a type error at every call site that needs the key it just created.
 */
export type Persisted<T> = T & { id: string; created_at?: string };

/** A predicate on a row, expressed as equality on a set of columns. */
export type Where = Record<string, unknown>;

export interface VectorQuery {
  table: string;
  column: string;
  embedding: number[];
  limit: number;
  where?: Where;
}

export interface VectorHit<T = Row> {
  row: T;
  similarity: number;
}

export interface Store {
  readonly kind: 'local' | 'supabase';

  insert<T extends Row>(table: string, rows: T | T[]): Promise<Array<Persisted<T>>>;
  /** Insert, or replace the row matching `conflict` columns. */
  upsert<T extends Row>(
    table: string,
    rows: T | T[],
    conflict: string[],
  ): Promise<Array<Persisted<T>>>;
  update(table: string, where: Where, patch: Row): Promise<number>;
  select<T extends Row>(table: string, where?: Where): Promise<T[]>;
  selectOne<T extends Row>(table: string, where: Where): Promise<T | null>;
  delete(table: string, where: Where): Promise<number>;
  count(table: string, where?: Where): Promise<number>;

  /** Cosine similarity search over an embedding column. */
  nearest<T extends Row>(query: VectorQuery): Promise<Array<VectorHit<T>>>;

  /** Queue operations. Backed by pgmq in Postgres, a table locally. */
  enqueue(queue: string, message: Row): Promise<string>;
  dequeue(queue: string, visibilityMs?: number): Promise<{ id: string; message: Row } | null>;
  ack(queue: string, id: string): Promise<void>;
  queueDepth(queue: string): Promise<number>;
}

/** Cosine similarity. Returns 0 for a zero vector rather than NaN. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function matches(row: Row, where?: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    const actual = row[k];
    if (Array.isArray(v)) return v.includes(actual as never);
    return actual === v;
  });
}
