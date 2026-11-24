-- All In Capital — 0007 the revised decision model and automatic scheduling
--
-- The brief changed in three ways that the schema has to follow:
--
--  1. Riya is the decision maker, not an assistant to the partners. The decision is
--     hers, the note is optional, and any signed-in team member can record one —
--     sign-in is already limited to the fund's allowlist, so a second gate on top of
--     it would only slow down the person the tool exists for.
--
--  2. There are no per-score override buttons. Riya has no time to correct six
--     criteria one at a time, so the correction IS the decision: when she goes
--     against the recommendation, that disagreement is what gets embedded and shown
--     to the scorer next time.
--
--  3. Scheduling runs on its own after her one click. That needs somewhere to record
--     what was offered, what was booked, and which run owns a thread — because two
--     cron runs five minutes apart must not both book the same founder.

-- ---------------------------------------------------------------------------
-- 1. Decisions
-- ---------------------------------------------------------------------------

create table if not exists decisions (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references applications(id) on delete cascade,
  decision       text not null check (decision in ('advance','hold','pass')),
  -- Optional. A required note is a reason not to record the decision at all.
  note           text,
  -- What the tool had recommended at the moment she decided. Kept on the row so a
  -- later rubric change cannot rewrite history about whether she disagreed.
  recommendation_at_decision text,
  disagreed      boolean not null default false,
  decided_by     text not null,
  decided_at     timestamptz not null default now()
);

create index if not exists decisions_app_idx on decisions (application_id, decided_at desc);
create index if not exists decisions_disagreed_idx on decisions (disagreed) where disagreed;

-- The partner-only table this replaces. Dropped rather than left to rot: nothing
-- has written to it, and two tables meaning "the decision" is how a screen ends up
-- showing the wrong one.
drop table if exists partner_decisions;

-- ---------------------------------------------------------------------------
-- 2. Corrections become decision-level
-- ---------------------------------------------------------------------------

drop table if exists correction_uses;
drop table if exists corrections;

create table if not exists corrections (
  id             uuid primary key default gen_random_uuid(),
  decision_id    uuid not null references decisions(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  -- "Worth a call" -> "pass", or "Not now" -> "advance".
  recommended    text not null,
  decided        text not null,
  note           text,
  -- The application summary with the company and founder names removed, which is
  -- what gets embedded and what a future scorer is shown.
  redacted_text  text not null,
  embedding      vector(768),
  created_at     timestamptz not null default now()
);

create index if not exists corrections_embedding_idx
  on corrections using hnsw (embedding vector_cosine_ops);

-- Where a past disagreement was reused, so "did it count for something?" has an answer.
create table if not exists correction_uses (
  id             uuid primary key default gen_random_uuid(),
  correction_id  uuid not null references corrections(id) on delete cascade,
  application_id uuid not null references applications(id) on delete cascade,
  similarity     numeric(6,4),
  used_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Scheduling state
-- ---------------------------------------------------------------------------

alter table email_threads
  add column if not exists meeting_status text not null default 'none',
  -- none | times_offered | awaiting_founder | booked | needs_riya
  add column if not exists offered_slot_1 timestamptz,
  add column if not exists offered_slot_2 timestamptz,
  -- A run claims the thread before touching it. Two cron runs five minutes apart,
  -- or a cron run overlapping a local worker, must not both book the same call.
  add column if not exists claimed_at timestamptz,
  add column if not exists claimed_by text;

create index if not exists email_threads_meeting_status_idx
  on email_threads (meeting_status);

alter table calendar_events
  add column if not exists meet_link text,
  -- The event is recorded before the confirmation note is sent, so a crash between
  -- the two leaves a booked call with no note rather than a note with no call.
  add column if not exists confirmation_sent_at timestamptz;

-- What the deterministic reply parser decided, kept so a misread can be inspected
-- without re-reading the founder's mail.
alter table email_messages
  add column if not exists parsed_intent text,
  -- picked_offered | proposed_time | refusal | unclear
  add column if not exists proposed_start timestamptz,
  add column if not exists parser_note text;

-- ---------------------------------------------------------------------------
-- RLS for the new tables: same deny-by-default as every other table.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['decisions','corrections','correction_uses'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

comment on table decisions is
  'Riya decides. Advance, Hold or Pass with an optional note, recorded by any '
  'signed-in team member. Nothing is advanced or rejected automatically.';

comment on table corrections is
  'A correction is a decision that went against the recommendation. There are no '
  'per-criterion override buttons: Riya does not have time to correct six scores.';
