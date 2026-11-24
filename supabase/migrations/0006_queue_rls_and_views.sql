-- All In Capital — 0006 queue, row-level security, and operator views

-- ---------------------------------------------------------------------------
-- Queue (brief §3): one message per application, drained by cron in production
-- and by `pnpm worker` in development.
-- ---------------------------------------------------------------------------

select pgmq.create('applications');

-- ---------------------------------------------------------------------------
-- Sign-in allowlist. The session itself is a signed HMAC cookie issued by the
-- app; this table records who is allowed and which of them is a partner.
-- ---------------------------------------------------------------------------

create table if not exists app_users (
  email         text primary key,
  display_name  text,
  role          text not null default 'associate',   -- associate | partner
  is_mailbox    boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row-level security
--
-- The browser never talks to Postgres. All reads and writes go through server
-- routes holding the service key, which bypasses RLS by design. RLS is enabled
-- with NO policies for anon/authenticated so that a leaked publishable key
-- yields nothing at all — deny-by-default rather than deny-by-review.
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'rubric_versions','prompt_versions',
    'applications','founders','founder_contacts','documents','doc_pages','form_fields',
    'portfolio_companies','memos','memo_passages','partner_notes',
    'claims','recon_checks','research_queries','research_findings',
    'gate_results','criterion_scores','assessments',
    'email_drafts','email_threads','email_messages','style_examples',
    'calendar_events','partner_decisions',
    'corrections','correction_uses','calibration_runs','calibration_results',
    'jobs','llm_calls','llm_cache','spend_days','step_traces','app_users'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

comment on table founder_contacts is
  'Founder email, phone and LinkedIn. Never joined into a model payload; the '
  'send-less guard in src/lib/gateway/guards.ts throws if any value here appears '
  'in a prompt. No RLS policy grants access to anon or authenticated.';

-- ---------------------------------------------------------------------------
-- Operator views
-- ---------------------------------------------------------------------------

-- Cost per application, used by the terminal cost report (never shown in the UI).
create or replace view v_cost_per_application as
select
  a.id   as application_id,
  a.company_name,
  count(l.id)                       as calls,
  sum(l.input_tokens)               as input_tokens,
  sum(l.output_tokens)              as output_tokens,
  sum(l.cost_inr)                   as cost_inr,
  sum(case when l.cached then 1 else 0 end)    as cached_calls,
  sum(case when l.fell_back then 1 else 0 end) as fallback_calls,
  sum(l.retries)                    as retries
from applications a
left join llm_calls l on l.application_id = a.id
group by a.id, a.company_name;

-- What a non-engineer needs when something looks wrong.
create or replace view v_needs_a_look as
select
  a.company_name,
  j.step,
  j.attempts,
  j.plain_reason,
  j.finished_at
from jobs j
join applications a on a.id = j.application_id
where j.status in ('failed','needs_a_look')
order by j.finished_at desc nulls last;
