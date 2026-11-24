-- All In Capital — 0001 extensions and versioned config
-- Rubric and thesis are stored as versioned config (brief §5): every score records
-- the rubric and prompt version it used, and Settings edits create new versions.

create extension if not exists "pgcrypto";
create extension if not exists "vector";
create extension if not exists "pgmq";

-- ---------------------------------------------------------------------------
-- Versioned configuration
-- ---------------------------------------------------------------------------

-- A rubric version is an immutable snapshot. Editing weights in Settings inserts a
-- new row; it never updates an existing one. `is_active` marks the one in use.
create table if not exists rubric_versions (
  id            uuid primary key default gen_random_uuid(),
  version       integer not null unique,
  label         text not null,
  -- criteria: [{ key, name, weight, covers, anchors: {0,3,5,7,10} }]
  criteria      jsonb not null,
  -- sector lenses: { "consumer_brand": { "c3": 1.5, "c4": 1.5 }, ... }
  lenses        jsonb not null default '{}'::jsonb,
  -- written (public) view weights, applied with no lens
  written_view  jsonb not null,
  -- thresholds: { take_call: 7.5, dig_first: 6.0 }
  thresholds    jsonb not null,
  -- fund rules: cheque size, stage, excluded sectors, revealed rules R1..R9
  fund_rules    jsonb not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  created_by    text
);

create unique index if not exists rubric_versions_one_active
  on rubric_versions (is_active) where is_active;

-- Prompt versions are tracked separately so a prompt edit does not invalidate a
-- rubric, and Langfuse traces can record which prompt produced a run.
create table if not exists prompt_versions (
  id            uuid primary key default gen_random_uuid(),
  step          text not null,
  version       integer not null,
  template      text not null,
  -- sha256 of template, so a silent edit is detectable
  fingerprint   text not null,
  is_active     boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (step, version)
);

create unique index if not exists prompt_versions_one_active_per_step
  on prompt_versions (step) where is_active;
