-- All In Capital — 0003 pipeline: claims, reconciliation, research, gates, scores, ranking
-- Every row that a screen can show carries its own citation. Nothing is displayed
-- that cannot be traced to a deck page, a form field, or a web page.

-- ---------------------------------------------------------------------------
-- Step 2: extracted claims. A quote must appear verbatim on its page.
-- ---------------------------------------------------------------------------

create table if not exists claims (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  document_id   uuid references documents(id) on delete cascade,
  page_number   integer,
  metric        text not null,
  value_text    text,
  value_num     numeric(24,4),
  unit          text,                                -- INR|pct|count|months|x
  period        text,                                -- 'Oct 2026', 'cumulative', 'in 12 months'
  is_target     boolean not null default false,      -- "in 12 months…" is not an actual
  quote         text not null,
  quote_verified boolean not null default false,
  created_at    timestamptz not null default now()
);

create index if not exists claims_app_metric_idx on claims (application_id, metric);

-- ---------------------------------------------------------------------------
-- Step 3: reconciliation. Pure code; each check carries its formula.
-- ---------------------------------------------------------------------------

create table if not exists recon_checks (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  check_key     text not null,                       -- 'tam_recompute', 'team_size', …
  title         text not null,
  severity      text not null,                       -- red|warn|info
  -- the arithmetic, written out so a partner can check it by eye
  formula       text,
  expected      text,
  found         text,
  plain         text not null,                       -- one sentence, no jargon
  deck_claim_id uuid references claims(id) on delete set null,
  form_field_id uuid references form_fields(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (application_id, check_key)
);

-- ---------------------------------------------------------------------------
-- Step 4: research. Every query is logged, including the ones that found nothing.
-- ---------------------------------------------------------------------------

create table if not exists research_queries (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  intent        text not null,                       -- company|founder|conflict|controversy
  subject_token text,                                -- 'F1' — never a founder's name
  query         text not null,
  provider      text not null,
  result_count  integer not null default 0,
  was_empty     boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists research_findings (
  id            uuid primary key default gen_random_uuid(),
  query_id      uuid not null references research_queries(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  url           text not null,
  domain        text,
  title         text,
  quote         text not null,                       -- must appear on the fetched page
  quote_verified boolean not null default false,
  is_primary_source boolean not null default false,  -- primary beats aggregator
  confirms      text,                                -- what it confirms, one line
  set_aside_reason text,                             -- same name, different person
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Step 5: gates. A tripped gate sets the lane to "Kushal decides" — never a reject.
-- ---------------------------------------------------------------------------

create table if not exists gate_results (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  gate_key      text not null,                       -- g1_stage|g2_regulatory|g3_conflict|g4_integrity
  tripped       boolean not null,
  plain_name    text not null,                       -- 'Above our cheque size'
  reason        text not null,
  -- citations: [{ kind: 'deck'|'form'|'web'|'portfolio', ref, quote }]
  citations     jsonb not null default '[]'::jsonb,
  decided_by    text not null,                       -- 'code' | 'model'
  rubric_version integer,
  created_at    timestamptz not null default now(),
  unique (application_id, gate_key)
);

-- ---------------------------------------------------------------------------
-- Step 6: scores. One row per criterion. Uncited output above 2 is rejected.
-- ---------------------------------------------------------------------------

create table if not exists criterion_scores (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  criterion_key text not null,                       -- c1..c6
  view          text not null default 'revealed',    -- revealed | written
  score         numeric(4,2) not null check (score >= 0 and score <= 10),
  confidence    text not null,                       -- high|med|low
  rating_word   text not null,                       -- Strong|Promising|Mixed|Thin
  plain         text not null,                       -- one sentence a founder would understand
  ask           text,                                -- "Ask:" one question
  claim_ids     uuid[] not null default '{}',
  gap_named     text,                                -- what was missing, if anything
  rubric_version integer not null,
  prompt_version integer,
  is_override   boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (application_id, criterion_key, view)
);

-- ---------------------------------------------------------------------------
-- Step 7: ranking. Pure code.
-- ---------------------------------------------------------------------------

create table if not exists assessments (
  application_id   uuid primary key references applications(id) on delete cascade,
  view             text not null default 'revealed',
  weighted_score   numeric(4,2) not null,
  written_score    numeric(4,2),
  recommendation   text not null,                    -- take_call|dig_first|pass
  lane             text not null,                    -- worth_a_call|kushal_decides|dig_first|not_now
  bucket           text not null,                   -- clear|flagged|outside_mandate
  rank             integer,
  evidence_coverage numeric(5,2) not null default 0, -- share of criteria with cited claims
  rating_word      text not null,
  headline         text not null,                    -- "Strongest on customer pull; thinnest on why now."
  our_take         text,
  for_it           text,
  against_it       text,
  would_change     text,
  reminds_us_of    uuid references memos(id) on delete set null,
  reminds_why      text,
  rubric_version   integer not null,
  computed_at      timestamptz not null default now()
);

create index if not exists assessments_lane_rank_idx on assessments (lane, rank);
