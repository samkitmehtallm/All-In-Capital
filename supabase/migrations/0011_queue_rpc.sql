-- All In Capital — 0011 queue RPC wrappers
--
-- PostgREST can only call functions in a schema it has been told to expose, and
-- `pgmq` is not one of them. Supabase's Queues feature adds a `pgmq_public`
-- schema of wrappers for exactly this reason, but it is enabled from the
-- dashboard, so a fresh project restored from these migrations alone would have
-- a working queue that the application could not reach — the kind of setup step
-- that is remembered once and forgotten forever after.
--
-- These wrappers live in `public`, which is already exposed, so the queue works
-- from migrations alone. They are SECURITY DEFINER because `pgmq`'s own tables
-- are not reachable by the calling role, and their search_path is pinned so a
-- caller cannot shadow `pgmq` with a schema of their own.
--
-- Execute is revoked from anon and authenticated: the browser never touches the
-- queue. Only the service key, used by server routes and the worker, may.

create or replace function public.queue_send(queue_name text, message jsonb)
returns bigint
language plpgsql
security definer
set search_path = pgmq, public
as $$
declare msg_id bigint;
begin
  select * into msg_id from pgmq.send(queue_name, message);
  return msg_id;
end;
$$;

create or replace function public.queue_read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record
language plpgsql
security definer
set search_path = pgmq, public
as $$
begin
  return query select * from pgmq.read(queue_name, vt, qty);
end;
$$;

create or replace function public.queue_delete(queue_name text, msg_id bigint)
returns boolean
language plpgsql
security definer
set search_path = pgmq, public
as $$
declare deleted boolean;
begin
  select * into deleted from pgmq.delete(queue_name, msg_id);
  return deleted;
end;
$$;

-- Depth without pgmq_metrics, which reports a great deal more than is wanted and
-- is slower for it. "Visible now" is the number that matters when asking whether
-- the queue drained: a message held by a live visibility timeout is in flight,
-- not lost, and counting it as depth would make a healthy drain look stuck.
create or replace function public.queue_depth(queue_name text)
returns bigint
language plpgsql
security definer
set search_path = pgmq, public
as $$
declare n bigint;
begin
  execute format('select count(*) from pgmq.q_%I where vt <= now()', queue_name) into n;
  return n;
end;
$$;

revoke all on function public.queue_send(text, jsonb)       from anon, authenticated;
revoke all on function public.queue_read(text, integer, integer) from anon, authenticated;
revoke all on function public.queue_delete(text, bigint)    from anon, authenticated;
revoke all on function public.queue_depth(text)             from anon, authenticated;

grant execute on function public.queue_send(text, jsonb)       to service_role;
grant execute on function public.queue_read(text, integer, integer) to service_role;
grant execute on function public.queue_delete(text, bigint)    to service_role;
grant execute on function public.queue_depth(text)             to service_role;
