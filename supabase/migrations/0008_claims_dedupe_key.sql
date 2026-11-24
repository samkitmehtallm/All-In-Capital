-- Claim idempotency.
--
-- Re-running the pipeline must not duplicate claims. The natural key is the metric
-- plus the quote, but a quote is free text up to 25 words and indexing it directly
-- risks the btree row-size limit on a long one. A sha256 of metric+quote is fixed
-- width, so the constraint is cheap and the intent is visible in the schema rather
-- than buried in an ON CONFLICT clause.
--
-- Found by running the pipeline against Postgres: the local JSON store matches
-- conflict columns in application code and accepted (application_id, metric, quote)
-- happily, while Postgres correctly refused an ON CONFLICT with no matching index.
-- A difference between the adapters is exactly what the local store is supposed not
-- to hide, so the constraint belongs here rather than a looser upsert in code.
alter table claims
  add column if not exists dedupe_key text;

update claims
   set dedupe_key = encode(sha256((coalesce(metric,'') || '|' || coalesce(quote,''))::bytea), 'hex')
 where dedupe_key is null;

alter table claims
  alter column dedupe_key set not null;

create unique index if not exists claims_app_dedupe_idx
  on claims (application_id, dedupe_key);
