-- All In Capital — 0012 style examples: a stable identity per source row
--
-- Re-running the seed must not duplicate Riya's emails. Without a key to upsert
-- on, a second run turns 58 examples into 116 and every draft is then shown the
-- same three emails twice over.
--
-- The row id from the B6 export is that key for seeded rows. Emails Riya sends
-- from the app have no export row, so the column is nullable.
--
-- The index is deliberately NOT partial. A partial unique index cannot back an
-- ON CONFLICT clause unless the statement repeats its WHERE, which supabase-js
-- has no way to express, and the upsert fails with "no unique or exclusion
-- constraint matching the ON CONFLICT specification" — the same wall the claims
-- table hit in 0008. Postgres already treats NULLs as distinct in a unique
-- index, so a plain one allows any number of app-sent examples with no row id.

alter table style_examples
  add column if not exists source_row_id text;

create unique index if not exists style_examples_source_row_idx
  on style_examples (source_row_id);

-- Retrieval is always "examples for this template", so the vector search has a
-- template filter in front of it.
create index if not exists style_examples_template_idx
  on style_examples (template);
