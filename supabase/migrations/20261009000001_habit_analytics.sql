-- Backfill and live inserts share a transaction so the initial counts cannot race.
begin;
lock table public.history in share row exclusive mode;
create table public.analytics_coverage (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  available_since timestamptz not null
);
create table public.reminder_daily_analytics (
  owner_id uuid not null references auth.users(id) on delete cascade,
  reminder_id text collate "C" not null,
  local_day date not null,
  timezone text not null,
  completed bigint not null default 0 check (completed >= 0),
  postponed bigint not null default 0 check (postponed >= 0),
  primary key (owner_id, reminder_id, local_day, timezone),
  foreign key (reminder_id, owner_id) references public.reminders(id, owner_id) on delete cascade
);
create table public.occurrence_action_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  action_id text not null check (length(action_id) between 1 and 200),
  reminder_id text collate "C" not null,
  request_key text not null,
  result jsonb not null,
  primary key (owner_id, action_id),
  foreign key (reminder_id, owner_id) references public.reminders(id, owner_id) on delete cascade
);
alter table public.analytics_coverage enable row level security;
alter table public.reminder_daily_analytics enable row level security;
alter table public.occurrence_action_receipts enable row level security;
create policy analytics_coverage_owner on public.analytics_coverage for select to authenticated using (owner_id = auth.uid());
create policy analytics_owner on public.reminder_daily_analytics for select to authenticated using (owner_id = auth.uid());
create policy action_receipts_owner on public.occurrence_action_receipts for select to authenticated using (owner_id = auth.uid());
revoke all on public.analytics_coverage, public.reminder_daily_analytics, public.occurrence_action_receipts from anon, authenticated;
grant select on public.analytics_coverage, public.reminder_daily_analytics, public.occurrence_action_receipts to authenticated;
grant all on public.analytics_coverage, public.reminder_daily_analytics, public.occurrence_action_receipts to service_role;

insert into public.analytics_coverage(owner_id, available_since)
select id, greatest(created_at, now() - interval '30 days') from auth.users;
insert into public.reminder_daily_analytics(owner_id, reminder_id, local_day, timezone, completed, postponed)
select h.owner_id, h.reminder_id, (h.occurred_at at time zone r.timezone)::date, r.timezone,
  count(*) filter (where h.event_type = 'completed'), count(*) filter (where h.event_type = 'postponed')
from public.history h join public.reminders r on r.id = h.reminder_id and r.owner_id = h.owner_id
where h.event_type in ('completed', 'postponed')
group by h.owner_id, h.reminder_id, (h.occurred_at at time zone r.timezone)::date, r.timezone;

create function public.initialize_analytics()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Sign in to load analytics'; end if;
  insert into public.analytics_coverage(owner_id, available_since)
  select id, created_at from auth.users where id = auth.uid() on conflict do nothing;
end;
$$;
create function public.record_daily_analytics()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  zone text;
begin
  if new.event_type not in ('completed', 'postponed') then return new; end if;
  select timezone into strict zone from public.reminders where id = new.reminder_id and owner_id = new.owner_id;
  insert into public.analytics_coverage(owner_id, available_since)
  select id, created_at from auth.users where id = new.owner_id on conflict do nothing;
  insert into public.reminder_daily_analytics(owner_id, reminder_id, local_day, timezone, completed, postponed)
  values (new.owner_id, new.reminder_id, (new.occurred_at at time zone zone)::date, zone,
    case when new.event_type = 'completed' then 1 else 0 end,
    case when new.event_type = 'postponed' then 1 else 0 end)
  on conflict (owner_id, reminder_id, local_day, timezone) do update
    set completed = public.reminder_daily_analytics.completed + excluded.completed,
        postponed = public.reminder_daily_analytics.postponed + excluded.postponed;
  return new;
end;
$$;
create trigger history_record_daily_analytics after insert on public.history
  for each row execute function public.record_daily_analytics();
revoke all on function public.record_daily_analytics() from public, anon, authenticated;
revoke all on function public.initialize_analytics() from public, anon;
grant execute on function public.initialize_analytics() to authenticated;

alter function public.act_on_occurrence(text, text, integer) rename to act_on_occurrence_without_receipt;
alter function public.postpone_occurrence(text, uuid, timestamptz, timestamptz, integer, bigint) rename to postpone_occurrence_without_receipt;
revoke all on function public.act_on_occurrence_without_receipt(text, text, integer),
  public.postpone_occurrence_without_receipt(text, uuid, timestamptz, timestamptz, integer, bigint)
  from public, anon, authenticated, service_role;

create function public.act_on_occurrence(
  p_occurrence_id text, p_event text, p_snooze_minutes integer,
  p_action_id text default null, p_request_key text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
  receipt public.occurrence_action_receipts%rowtype;
  reminder text;
  updated boolean;
begin
  if owner is null then return false; end if;
  if p_action_id is not null then
    if p_request_key is null then raise exception 'Action identity is required'; end if;
    if p_request_key::jsonb ->> 0 is distinct from p_occurrence_id
      or p_request_key::jsonb ->> 1 is distinct from (case when p_event = 'completed' then 'complete' else 'dismiss' end) then
      raise exception 'Action identity does not match the request';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner::text || ':' || p_action_id, 2));
    select * into receipt from public.occurrence_action_receipts where owner_id = owner and action_id = p_action_id;
    if found then
      if receipt.request_key <> p_request_key then raise exception 'Action ID was already used for another request'; end if;
      return true;
    end if;
  end if;
  updated := public.act_on_occurrence_without_receipt(p_occurrence_id, p_event, p_snooze_minutes);
  if updated and p_action_id is not null then
    select reminder_id into strict reminder from public.occurrences where id = p_occurrence_id and owner_id = owner;
    insert into public.occurrence_action_receipts(owner_id, action_id, reminder_id, request_key, result)
    values (owner, p_action_id, reminder, p_request_key, '{"updated":true}');
  end if;
  return updated;
end;
$$;

create function public.postpone_occurrence(
  p_occurrence_id text, p_owner_id uuid, p_until timestamptz,
  p_next_occurrence_at timestamptz, p_schedule_revision integer, p_occurrence_count bigint,
  p_action_id text default null, p_request_key text default null
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  receipt public.occurrence_action_receipts%rowtype;
  reminder text;
  updated boolean;
begin
  if p_action_id is not null then
    if p_request_key is null then raise exception 'Action identity is required'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text || ':' || p_action_id, 2));
    select * into receipt from public.occurrence_action_receipts where owner_id = p_owner_id and action_id = p_action_id;
    if found then
      if receipt.request_key <> p_request_key then raise exception 'Action ID was already used for another request'; end if;
      return true;
    end if;
  end if;
  updated := public.postpone_occurrence_without_receipt(
    p_occurrence_id, p_owner_id, p_until, p_next_occurrence_at, p_schedule_revision, p_occurrence_count);
  if updated and p_action_id is not null then
    select reminder_id into strict reminder from public.occurrences where id = p_occurrence_id and owner_id = p_owner_id;
    insert into public.occurrence_action_receipts(owner_id, action_id, reminder_id, request_key, result)
    values (p_owner_id, p_action_id, reminder, p_request_key,
      jsonb_build_object('updated', true, 'until', p_until, 'mergedIntoNext', coalesce(p_until = p_next_occurrence_at, false)));
  end if;
  return updated;
end;
$$;
revoke all on function public.act_on_occurrence(text, text, integer, text, text),
  public.postpone_occurrence(text, uuid, timestamptz, timestamptz, integer, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.act_on_occurrence(text, text, integer, text, text) to authenticated;
grant execute on function public.postpone_occurrence(text, uuid, timestamptz, timestamptz, integer, bigint, text, text) to service_role;
commit;
