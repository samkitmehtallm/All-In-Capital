-- All In Capital — 0002 core domain: applications, documents, founders, portfolio, memos
--
-- PII boundary (brief §2.3): founder email, phone and LinkedIn live ONLY in
-- founder_contacts. Every model-facing path reads `founders`, which carries the
-- redaction token ([F1], [F2]) and nothing that identifies a person.

create table if not exists applications (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,              -- 'grainkind'
  company_name    text not null,
  legal_name      text,
  one_liner       text,
  website         text,
  location        text,
  incorporated_on text,
  sector_declared text,                              -- as the founder selected it
  sector_resolved text,                              -- what the lens actually applies
  stage_declared  text,
  team_size_form  integer,
  -- fundraising, canonical rupees (deterministic parse of "INR 2.5 Cr")
  raise_inr       numeric(20,2),
  post_money_inr  numeric(20,2),
  raise_text      text,
  post_money_text text,
  -- pipeline state
  status          text not null default 'received',  -- received|reading|scored|needs_a_look
  needs_look_reason text,
  received_at     timestamptz not null default now(),
  first_opened_at timestamptz,                       -- email drafts only after Riya opens (§7.8)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists applications_status_idx on applications (status);

-- Founders as the model sees them: a token, a role, and claims about background.
create table if not exists founders (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  token         text not null,                       -- 'F1' — the ONLY handle a prompt gets
  ordinal       integer not null,
  role          text,
  background_form text,                              -- as written on the form
  created_at    timestamptz not null default now(),
  unique (application_id, token)
);

-- Never joined into any model payload. Enforced in code by the send-less guard and
-- in the database by RLS: no anon/authenticated policy exists for this table.
create table if not exists founder_contacts (
  founder_id    uuid primary key references founders(id) on delete cascade,
  full_name     text not null,
  email         text,
  phone         text,
  linkedin_url  text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Documents and pages
-- ---------------------------------------------------------------------------

create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  kind          text not null,                       -- 'deck' | 'form'
  filename      text not null,
  sha256        text not null,
  page_count    integer not null,
  created_at    timestamptz not null default now(),
  unique (application_id, kind)
);

-- Page text is the citation substrate: a claim's quote must appear verbatim here.
create table if not exists doc_pages (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references documents(id) on delete cascade,
  page_number   integer not null,
  raw_text      text not null,
  -- whitespace-normalised copy used for verbatim quote verification
  norm_text     text not null,
  redacted_text text not null,                       -- what a model is allowed to see
  unique (document_id, page_number)
);

-- Deterministically parsed form fields (label/value, no model — brief §7.1)
create table if not exists form_fields (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  section       text,
  label         text not null,
  value         text not null,
  page_number   integer not null,
  unique (application_id, label)
);

-- ---------------------------------------------------------------------------
-- The fund's own record
-- ---------------------------------------------------------------------------

create table if not exists portfolio_companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  one_liner     text,
  sector        text,
  status        text not null default 'active',      -- active|exited|shut_down
  tags          text[] not null default '{}',
  domain        text,                                -- for the favicon route
  source_url    text,
  source_note   text,
  embedding     vector(768),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists memos (
  id            uuid primary key default gen_random_uuid(),
  ordinal       integer not null unique,
  company       text not null,
  sector        text,
  stage         text,
  source        text,
  decision      text not null,                       -- INVESTED | PASSED
  what_it_does  text,
  founder_assessment text,
  risks         text,
  why           text,                                -- the outcome; withheld when scoring blind
  created_at    timestamptz not null default now()
);

-- Chunked for retrieval. The scorer sees top passages, never every memo (§2.3).
create table if not exists memo_passages (
  id            uuid primary key default gen_random_uuid(),
  memo_id       uuid not null references memos(id) on delete cascade,
  section       text not null,                       -- what_it_does|founder_assessment|risks|why
  ordinal       integer not null,
  text          text not null,
  redacted_text text not null,
  embedding     vector(768),
  unique (memo_id, section, ordinal)
);

create index if not exists memo_passages_embedding_idx
  on memo_passages using hnsw (embedding vector_cosine_ops);

create index if not exists portfolio_embedding_idx
  on portfolio_companies using hnsw (embedding vector_cosine_ops);

create table if not exists partner_notes (
  id            uuid primary key default gen_random_uuid(),
  meeting_no    integer not null,
  title         text not null,
  present       text,
  body          text not null,
  embedding     vector(768),
  created_at    timestamptz not null default now(),
  unique (meeting_no)
);
