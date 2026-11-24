-- All In Capital — 0004 outreach: drafts, linting, threads, calendar, partner decisions
-- A human clicks every send (brief §2.5). Nothing in this file sends anything;
-- `sent_at` is only ever written by the route that handles an explicit click.

create table if not exists email_drafts (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  template      text not null,                       -- call_invite|dig|pass|follow_up
  subject       text not null,
  body          text not null,
  -- slot placeholders are resolved only at review-and-send time
  slot_1        timestamptz,
  slot_2        timestamptz,
  generation    integer not null default 1,          -- linter allows up to 3
  lint_passed   boolean not null default false,
  lint_failures jsonb not null default '[]'::jsonb,
  -- the 3 of Riya's real sent emails shown to the model for this draft
  example_ids   uuid[] not null default '{}',
  model         text,
  prompt_version integer,
  is_current    boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Versions are saved, but there is no version-history UI (brief §8).
create index if not exists email_drafts_app_idx on email_drafts (application_id, created_at desc);

create table if not exists email_threads (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  gmail_thread_id text,
  subject       text not null,
  status        text not null default 'draft',       -- draft|sent|replied|booked|closed
  last_sent_at  timestamptz,
  last_reply_at timestamptz,
  follow_up_due_on date,
  created_at    timestamptz not null default now()
);

create table if not exists email_messages (
  id            uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references email_threads(id) on delete cascade,
  direction     text not null,                       -- outbound|inbound
  gmail_message_id text,
  subject       text,
  body          text not null,
  -- who clicked send, and when. Null for inbound.
  sent_by       text,
  sent_at       timestamptz,
  received_at   timestamptz,
  -- no-model reply classifier (brief §9)
  reply_class   text,                                -- picked_slot|proposed_times|needs_a_person
  reply_class_evidence text,
  created_at    timestamptz not null default now()
);

-- Every email Riya edits and sends becomes a style example for the next draft.
create table if not exists style_examples (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'sent',        -- sent|seed_export
  template      text not null,
  sector        text,
  stage         text,
  founder_type  text,
  subject       text,
  body          text not null,                       -- already redacted to [F1]
  word_count    integer not null,
  embedding     vector(768),
  created_at    timestamptz not null default now()
);

create index if not exists style_examples_embedding_idx
  on style_examples using hnsw (embedding vector_cosine_ops);

create table if not exists calendar_events (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  thread_id     uuid references email_threads(id) on delete set null,
  google_event_id text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  attendees     text[] not null default '{}',
  aditya_invited boolean not null default false,     -- deeptech only
  booked_by     text not null,
  created_at    timestamptz not null default now()
);

-- Partners only. Enforced by RLS below and by a server-side partner check.
create table if not exists partner_decisions (
  id            uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  decision      text not null,                       -- advance|hold|pass
  note          text not null,                       -- required
  decided_by    text not null,
  decided_at    timestamptz not null default now()
);

create index if not exists partner_decisions_app_idx
  on partner_decisions (application_id, decided_at desc);
