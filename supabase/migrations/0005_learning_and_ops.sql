-- All In Capital — 0005 learning loops, calibration, queue, observability, spend

-- ---------------------------------------------------------------------------
-- Loop 1: corrections. A correction must count for something next time (§10).
-- ---------------------------------------------------------------------------

create table if not exists corrections (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  criterion_key text not null,
  old_score     numeric(4,2) not null,
  new_score     numeric(4,2) not null check (new_score >= 0 and new_score <= 10),
  reason        text not null,                       -- required, one line
  tags          text[] not null default '{}',
  corrected_by  text not null,
  -- the company name is redacted before this text is ever embedded or shown
  redacted_text text not null,
  embedding     vector(768),
  created_at    timestamptz not null default now()
);

create index if not exists corrections_embedding_idx
  on corrections using hnsw (embedding vector_cosine_ops);

-- Where a past correction was reused, so "did it count?" is answerable.
create table if not exists correction_uses (
  id            uuid primary key default gen_random_uuid(),
  correction_id uuid not null references corrections(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  criterion_key text not null,
  similarity    numeric(6,4),
  used_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Calibration: score the 12 memos blind, compare against what the fund did.
-- ---------------------------------------------------------------------------

create table if not exists calibration_runs (
  id            uuid primary key default gen_random_uuid(),
  rubric_version integer not null,
  prompt_version integer,
  agreement_n   integer not null default 0,
  agreement_d   integer not null default 0,
  -- confusion: { invested_call: n, invested_pass: n, passed_call: n, passed_pass: n }
  confusion     jsonb not null default '{}'::jsonb,
  pair_agreement jsonb not null default '[]'::jsonb, -- does the backed company outscore the passed one
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists calibration_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references calibration_runs(id) on delete cascade,
  memo_id       uuid not null references memos(id) on delete cascade,
  system_score  numeric(4,2) not null,
  system_call   text not null,                       -- take_call|dig_first|pass
  fund_decision text not null,                       -- INVESTED|PASSED
  agreed        boolean not null,
  -- one plain sentence each, max 20 words, no citation tags in the text
  case_for      text,
  case_against  text,
  -- sources kept out of the sentence, in their own field
  case_sources  jsonb not null default '[]'::jsonb,
  unique (run_id, memo_id)
);

-- ---------------------------------------------------------------------------
-- Queue and jobs. One queue message per application, a jobs row per step.
-- ---------------------------------------------------------------------------

create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  step          text not null,                       -- ingest|extract|reconcile|research|gates|score|rank|draft
  status        text not null default 'pending',     -- pending|running|done|failed|needs_a_look
  attempts      integer not null default 0,
  -- idempotency: a step that has already produced its output is not redone
  idempotency_key text not null,
  error         text,
  plain_reason  text,                                -- what a non-engineer should read
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (idempotency_key)
);

create index if not exists jobs_status_idx on jobs (status, step);

-- ---------------------------------------------------------------------------
-- Observability: one row per model call. Feeds the terminal cost report.
-- ---------------------------------------------------------------------------

create table if not exists llm_calls (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete set null,
  trace_id      text,
  step          text not null,
  model         text not null,
  prompt_version integer,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(12,6) not null default 0,
  cost_inr      numeric(12,4) not null default 0,
  latency_ms    integer not null default 0,
  retries       integer not null default 0,
  fell_back     boolean not null default false,
  cached        boolean not null default false,
  ok            boolean not null default true,
  error         text,
  created_at    timestamptz not null default now()
);

create index if not exists llm_calls_created_idx on llm_calls (created_at desc);
create index if not exists llm_calls_app_idx on llm_calls (application_id);

-- 30-day cache for deterministic calls (temperature <= 0.2), keyed on
-- sha256(model + system + user). Logs are a second copy of founder data, so
-- entries expire (§12.2).
create table if not exists llm_cache (
  cache_key     text primary key,                    -- sha256(model|system|user)
  model         text not null,
  response      jsonb not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  hits          integer not null default 0,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '30 days')
);

create index if not exists llm_cache_expires_idx on llm_cache (expires_at);

-- Daily spend cap: pauses the queue, resumes on its own after midnight IST.
create table if not exists spend_days (
  day_ist       date primary key,
  spend_inr     numeric(12,4) not null default 0,
  cap_inr       numeric(12,4) not null,
  paused_at     timestamptz,
  created_at    timestamptz not null default now()
);

-- Pipeline step traces, so a run can be opened and inspected without Langfuse.
create table if not exists step_traces (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid references applications(id) on delete cascade,
  trace_id      text not null,
  step          text not null,
  status        text not null,
  duration_ms   integer,
  detail        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists step_traces_trace_idx on step_traces (trace_id, created_at);
