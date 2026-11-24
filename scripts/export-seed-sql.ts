/**
 * Emit the local store as SQL, for seeding Postgres without a service key.
 *
 * `pnpm seed` is the normal path and needs SUPABASE_SERVICE_KEY. This script exists
 * because the schema can be reached over an authenticated admin connection that
 * cannot hand that key to the app — so the rows are written as SQL instead.
 *
 * Embeddings are deliberately omitted. The local ones come from the offline
 * provider, which is a deterministic test double, not a semantic model: shipping
 * them to production would put 70 fake vectors behind the conflict check and make
 * G3 look like it works. They are regenerated from the real embedding model by
 * `pnpm seed:embeddings` once GEMINI_API_KEY is set.
 *
 * Run: pnpm export:sql
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DATA = join(ROOT, '.data');
const OUT = join(ROOT, '.data', 'sql');

/**
 * Tables to export, in foreign-key order.
 *
 * Foreign keys are resolved by NATURAL KEY in a subquery, not by the local row's
 * UUID. The local store generates a fresh UUID on every seed, so emitting those ids
 * produces SQL whose founders point at applications that no longer exist in a
 * database seeded from an earlier run. Resolving `(select id from applications where
 * slug = 'grainkind')` makes the file idempotent and safe to re-apply.
 */
interface TableSpec {
  table: string;
  /** Plain columns copied as-is. */
  columns: string[];
  conflict: string[];
  /** Foreign keys emitted as a subquery, built from the local row. */
  foreignKeys?: Record<string, (row: Record<string, unknown>, ctx: Ctx) => string>;
}

/** Lookups from local UUID back to the natural key, built as the export runs. */
interface Ctx {
  applicationSlugById: Map<string, string>;
  founderKeyById: Map<string, { slug: string; token: string }>;
  documentKeyById: Map<string, { slug: string; kind: string }>;
  memoOrdinalById: Map<string, number>;
}

const lit = (v: unknown) => `'${String(v).replace(/'/g, "''")}'`;

const TABLES: TableSpec[] = [
  {
    table: 'rubric_versions',
    columns: ['version', 'label', 'criteria', 'lenses', 'written_view', 'thresholds', 'fund_rules', 'is_active'],
    conflict: ['version'],
  },
  {
    table: 'applications',
    columns: [
      'slug', 'company_name', 'legal_name', 'one_liner', 'website', 'location',
      'incorporated_on', 'sector_declared', 'stage_declared', 'team_size_form',
      'raise_inr', 'post_money_inr', 'raise_text', 'post_money_text', 'status',
    ],
    conflict: ['slug'],
  },
  {
    table: 'founders',
    columns: ['token', 'ordinal', 'role', 'background_form'],
    conflict: ['application_id', 'token'],
    foreignKeys: {
      application_id: (row, ctx) =>
        `(select id from applications where slug = ${lit(ctx.applicationSlugById.get(String(row.application_id)))})`,
    },
  },
  {
    table: 'founder_contacts',
    columns: ['full_name', 'email', 'phone', 'linkedin_url'],
    conflict: ['founder_id'],
    foreignKeys: {
      founder_id: (row, ctx) => {
        const key = ctx.founderKeyById.get(String(row.founder_id));
        return `(select f.id from founders f join applications a on a.id = f.application_id where a.slug = ${lit(key?.slug)} and f.token = ${lit(key?.token)})`;
      },
    },
  },
  {
    table: 'documents',
    columns: ['kind', 'filename', 'sha256', 'page_count'],
    conflict: ['application_id', 'kind'],
    foreignKeys: {
      application_id: (row, ctx) =>
        `(select id from applications where slug = ${lit(ctx.applicationSlugById.get(String(row.application_id)))})`,
    },
  },
  {
    table: 'form_fields',
    columns: ['label', 'value', 'page_number'],
    conflict: ['application_id', 'label'],
    foreignKeys: {
      application_id: (row, ctx) =>
        `(select id from applications where slug = ${lit(ctx.applicationSlugById.get(String(row.application_id)))})`,
    },
  },
  {
    table: 'doc_pages',
    columns: ['page_number', 'raw_text', 'norm_text', 'redacted_text'],
    conflict: ['document_id', 'page_number'],
    foreignKeys: {
      document_id: (row, ctx) => {
        const key = ctx.documentKeyById.get(String(row.document_id));
        return `(select d.id from documents d join applications a on a.id = d.application_id where a.slug = ${lit(key?.slug)} and d.kind = ${lit(key?.kind)})`;
      },
    },
  },
  {
    table: 'memos',
    columns: [
      'ordinal', 'company', 'sector', 'stage', 'source', 'decision',
      'what_it_does', 'founder_assessment', 'risks', 'why',
    ],
    conflict: ['ordinal'],
  },
  {
    table: 'memo_passages',
    columns: ['section', 'ordinal', 'text', 'redacted_text'],
    conflict: ['memo_id', 'section', 'ordinal'],
    foreignKeys: {
      memo_id: (row, ctx) =>
        `(select id from memos where ordinal = ${ctx.memoOrdinalById.get(String(row.memo_id)) ?? 'null'})`,
    },
  },
  {
    table: 'partner_notes',
    columns: ['meeting_no', 'title', 'present', 'body'],
    conflict: ['meeting_no'],
  },
  {
    table: 'portfolio_companies',
    columns: ['name', 'one_liner', 'sector', 'status', 'tags', 'domain', 'source_url', 'source_note'],
    conflict: ['name'],
  },
];

/** Columns that are jsonb in Postgres and objects in the local store. */
const JSON_COLUMNS = new Set(['criteria', 'lenses', 'written_view', 'thresholds', 'fund_rules']);
/** Columns that are text[] in Postgres. */
const ARRAY_COLUMNS = new Set(['tags']);

function quote(value: unknown, column: string): string {
  if (value === null || value === undefined) return 'null';

  if (ARRAY_COLUMNS.has(column)) {
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) return `'{}'`;
    return `ARRAY[${items.map((v) => lit(v)).join(',')}]::text[]`;
  }

  if (JSON_COLUMNS.has(column)) {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }

  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  return lit(value);
}

function readTable(name: string): Array<Record<string, unknown>> {
  const path = join(DATA, `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

function buildCtx(): Ctx {
  const applications = readTable('applications');
  const founders = readTable('founders');
  const documents = readTable('documents');
  const memos = readTable('memos');

  const applicationSlugById = new Map<string, string>(
    applications.map((a) => [String(a.id), String(a.slug)]),
  );

  return {
    applicationSlugById,
    founderKeyById: new Map(
      founders.map((f) => [
        String(f.id),
        { slug: applicationSlugById.get(String(f.application_id)) ?? '', token: String(f.token) },
      ]),
    ),
    documentKeyById: new Map(
      documents.map((d) => [
        String(d.id),
        { slug: applicationSlugById.get(String(d.application_id)) ?? '', kind: String(d.kind) },
      ]),
    ),
    memoOrdinalById: new Map(memos.map((m) => [String(m.id), Number(m.ordinal)])),
  };
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const ctx = buildCtx();
  const manifest: Array<{ file: string; table: string; rows: number; bytes: number }> = [];

  for (const spec of TABLES) {
    const rows = readTable(spec.table);
    if (rows.length === 0) {
      console.log(`  ${spec.table.padEnd(22)} skipped (no local rows)`);
      continue;
    }

    const fkColumns = Object.keys(spec.foreignKeys ?? {});
    const allColumns = [...fkColumns, ...spec.columns];

    const values = rows
      .map((row) => {
        const fk = fkColumns.map((c) => spec.foreignKeys![c](row, ctx));
        const plain = spec.columns.map((c) => quote(row[c], c));
        return `(${[...fk, ...plain].join(',')})`;
      })
      .join(',\n');

    const updates = allColumns
      .filter((c) => !spec.conflict.includes(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(', ');

    const sql =
      `insert into ${spec.table} (${allColumns.join(',')}) values\n${values}\n` +
      `on conflict (${spec.conflict.join(',')}) do update set ${updates};\n`;

    const file = `${String(manifest.length + 1).padStart(2, '0')}_${spec.table}.sql`;
    writeFileSync(join(OUT, file), sql);
    manifest.push({ file, table: spec.table, rows: rows.length, bytes: sql.length });
    console.log(`  ${spec.table.padEnd(22)} ${String(rows.length).padStart(4)} rows  ${String(sql.length).padStart(7)} bytes  -> ${file}`);
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const total = manifest.reduce((a, m) => a + m.bytes, 0);
  console.log(`\n  ${manifest.length} files, ${total} bytes total`);
  console.log('  Foreign keys resolved by natural key, so these files are idempotent.');
  console.log('  Embeddings omitted on purpose: see the header of this script.');
}

main();
