alter table public.occurrences
  add column postponed_to_next boolean not null default false;

create or replace function public.act_on_occurrence(
  p_occurrence_id text,
  p_event text,
  p_snooze_minutes integer
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  acted public.occurrences%rowtype;
  requesting_user uuid := auth.uid();
begin
  if requesting_user is null then return false; end if;
  if p_event is null or p_event not in ('dismissed', 'completed') then
    raise exception 'Postponement must be validated by the occurrence-action service';
  end if;
  update public.occurrences
  set status = p_event::public.occurrence_status,
      acted_at = now(),
      snoozed_until = null,
      next_delivery_attempt_at = null,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = requesting_user
    and status in (
      'scheduled', 'triggered', 'delivering', 'postponed', 'missed', 'delivery-failed'
    )
  returning * into acted;
  if not found then return false; end if;
  delete from public.expo_push_tickets
  where occurrence_id = acted.id and owner_id = acted.owner_id;
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (acted.reminder_id, acted.id, acted.owner_id, p_event::public.occurrence_status);
  return true;
end;
$$;

create or replace function public.postpone_occurrence(
  p_occurrence_id text,
  p_owner_id uuid,
  p_until timestamptz,
  p_next_occurrence_at timestamptz,
  p_schedule_revision integer,
  p_occurrence_count bigint
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  acted public.occurrences%rowtype;
begin
  if p_until is null or not isfinite(p_until) or p_until <= now() then
    raise exception 'Choose a future postponement time';
  end if;
  if p_next_occurrence_at is not null
    and (p_next_occurrence_at <= now() or p_until > p_next_occurrence_at) then
    raise exception 'Postponement cannot pass the next occurrence';
  end if;
  perform 1 from public.reminders reminder
  join public.occurrences occurrence
    on occurrence.reminder_id = reminder.id and occurrence.owner_id = reminder.owner_id
  where occurrence.id = p_occurrence_id
    and occurrence.owner_id = p_owner_id
    and reminder.status = 'active'
    and reminder.schedule_revision = p_schedule_revision
    and reminder.occurrence_count = p_occurrence_count
  for update of reminder;
  if not found then return false; end if;
  update public.occurrences
  set status = 'postponed',
      acted_at = now(),
      snoozed_until = p_until,
      postponed_to_next = coalesce(p_until = p_next_occurrence_at, false),
      delivered_at = null,
      delivery_attempts = 0,
      next_delivery_attempt_at = null,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status in ('triggered', 'delivering', 'missed', 'delivery-failed', 'postponed')
  returning * into acted;
  if not found then return false; end if;
  delete from public.expo_push_tickets
  where occurrence_id = acted.id and owner_id = acted.owner_id;
  delete from public.occurrence_device_deliveries
  where occurrence_id = acted.id and owner_id = acted.owner_id;
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (acted.reminder_id, acted.id, acted.owner_id, 'postponed');
  return true;
end;
$$;

revoke all on function public.postpone_occurrence(text, uuid, timestamptz, timestamptz, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.postpone_occurrence(text, uuid, timestamptz, timestamptz, integer, bigint)
  to service_role;

create or replace function public.claim_occurrence_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_reminder_id text,
  p_reminder_revision integer,
  p_lease_id uuid,
  p_now timestamptz,
  p_stale_before timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare claimed boolean;
begin
  update public.occurrences
  set status = 'delivering',
      acted_at = p_now,
      reminder_revision = case
        when status = 'postponed' then p_reminder_revision
        else reminder_revision
      end,
      delivery_lease_id = p_lease_id
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and reminder_id = p_reminder_id
    and not postponed_to_next
    and delivered_at is null
    and delivery_attempts < 5
    and (next_delivery_attempt_at is null or next_delivery_attempt_at <= p_now)
    and (
      status in ('triggered', 'delivery-failed')
      or (
        status = 'delivering'
        and (acted_at is null or acted_at < p_stale_before)
      )
      or (status = 'postponed' and snoozed_until <= p_now)
    )
    and exists (
      select 1 from public.reminders
      where id = p_reminder_id
        and owner_id = p_owner_id
        and status = 'active'
        and (
          public.occurrences.status = 'postponed'
          or (
            schedule_revision = p_reminder_revision
            and public.occurrences.reminder_revision = p_reminder_revision
          )
        )
    )
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.list_deliverable_occurrences(
  p_now timestamptz,
  p_stale_before timestamptz,
  p_limit integer,
  p_postponed boolean
)
returns table(occurrence_id text, reminder jsonb)
language sql security definer set search_path = '' as $$
  select occurrence.id, to_jsonb(reminder)
  from public.occurrences occurrence
  join public.reminders reminder
    on reminder.id = occurrence.reminder_id and reminder.owner_id = occurrence.owner_id
  where reminder.status = 'active'
    and not occurrence.postponed_to_next
    and occurrence.delivered_at is null
    and occurrence.delivery_attempts < 5
    and (
      (
        p_postponed
        and occurrence.status = 'postponed'
        and occurrence.snoozed_until <= p_now
      )
      or (
        not p_postponed
        and occurrence.reminder_revision = reminder.schedule_revision
        and (
          occurrence.status in ('triggered', 'delivery-failed')
          or (
            occurrence.status = 'delivering'
            and (occurrence.acted_at is null or occurrence.acted_at < p_stale_before)
          )
        )
        and (occurrence.next_delivery_attempt_at is null or occurrence.next_delivery_attempt_at <= p_now)
      )
    )
  order by
    coalesce(occurrence.snoozed_until, occurrence.next_delivery_attempt_at),
    occurrence.scheduled_at, occurrence.owner_id, occurrence.id
  limit greatest(p_limit, 0);
$$;

create or replace function public.delete_expired_history()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  deleted_history integer;
  deleted_occurrences integer;
begin
  delete from public.history where occurred_at < now() - interval '30 days';
  get diagnostics deleted_history = row_count;
  delete from public.occurrences
  where created_at < now() - interval '30 days'
    and not exists (
      select 1 from public.history
      where history.occurrence_id = occurrences.id
        and history.owner_id = occurrences.owner_id
        and history.occurred_at >= now() - interval '30 days'
    )
    and (
      status in ('dismissed', 'completed', 'missed')
      or postponed_to_next
      or delivered_at is not null
      or (status = 'delivery-failed' and delivery_attempts >= 5)
      or not exists (
        select 1 from public.reminders
        where reminders.id = occurrences.reminder_id
          and reminders.owner_id = occurrences.owner_id
          and reminders.status = 'active'
          and reminders.schedule_revision = occurrences.reminder_revision
      )
    );
  get diagnostics deleted_occurrences = row_count;
  return deleted_history + deleted_occurrences;
end;
$$;
