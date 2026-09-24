alter table public.occurrences add column delivered_at timestamptz;
alter table public.occurrences add column delivery_attempts integer not null default 0 check (delivery_attempts >= 0);
alter table public.occurrences add column next_delivery_attempt_at timestamptz;
alter table public.occurrences add column delivery_lease_id uuid;
alter table public.occurrences add column last_failed_delivery_round_id uuid;
alter type public.occurrence_status add value if not exists 'delivering' after 'triggered';
create index if not exists occurrences_pending_delivery_idx
  on public.occurrences(next_delivery_attempt_at, acted_at)
  where delivered_at is null
    and delivery_attempts < 5
    and status in ('triggered', 'delivering', 'delivery-failed');
create index if not exists occurrences_postponed_due_idx
  on public.occurrences(snoozed_until)
  where status = 'postponed';

create table if not exists public.occurrence_device_deliveries (
  occurrence_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (occurrence_id, owner_id, device_id),
  foreign key (occurrence_id, owner_id) references public.occurrences(id, owner_id) on delete cascade
);
create index if not exists occurrence_device_deliveries_owner_idx on public.occurrence_device_deliveries(owner_id, delivered_at desc);
alter table public.occurrence_device_deliveries enable row level security;

create table if not exists public.expo_push_tickets (
  ticket_id text primary key,
  occurrence_id text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null references public.devices(id) on delete cascade,
  delivery_round_id uuid not null,
  created_at timestamptz not null default now(),
  last_checked_at timestamptz,
  foreign key (occurrence_id, owner_id)
    references public.occurrences(id, owner_id) on delete cascade
);
create index if not exists expo_push_tickets_created_idx
  on public.expo_push_tickets(created_at);
create index if not exists expo_push_tickets_check_idx
  on public.expo_push_tickets(last_checked_at, created_at);
create index if not exists expo_push_tickets_occurrence_idx
  on public.expo_push_tickets(occurrence_id, owner_id);
alter table public.expo_push_tickets enable row level security;

drop policy if exists "owners manage occurrences" on public.occurrences;
do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'occurrences'
      and policyname = 'owners read occurrences'
  ) then
    create policy "owners read occurrences" on public.occurrences
      for select using (owner_id = auth.uid());
  end if;
end;
$$;

create or replace function public.record_missed_occurrence(
  p_occurrence_id text,
  p_reminder_id text,
  p_owner_id uuid,
  p_reminder_revision integer,
  p_scheduled_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.reminders
    where id = p_reminder_id
      and owner_id = p_owner_id
      and status = 'active'
      and revision = p_reminder_revision
  ) then
    return false;
  end if;
  insert into public.occurrences(
    id, reminder_id, owner_id, reminder_revision, scheduled_at, status
  )
  values (
    p_occurrence_id,
    p_reminder_id,
    p_owner_id,
    p_reminder_revision,
    p_scheduled_at,
    'missed'
  );
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (p_reminder_id, p_occurrence_id, p_owner_id, 'missed');
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

revoke all on function public.record_missed_occurrence(text, text, uuid, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.record_missed_occurrence(text, text, uuid, integer, timestamptz) to service_role;

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
      delivery_lease_id = p_lease_id
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and reminder_id = p_reminder_id
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
            revision = p_reminder_revision
            and public.occurrences.reminder_revision =
              p_reminder_revision
          )
        )
    )
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$;

create or replace function public.complete_occurrence_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_lease_id uuid,
  p_delivered_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare completed public.occurrences%rowtype;
begin
  update public.occurrences
  set status = 'triggered',
      delivered_at = p_delivered_at,
      next_delivery_attempt_at = null,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning * into completed;
  if not found then
    return false;
  end if;
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (completed.reminder_id, completed.id, completed.owner_id, 'triggered');
  return true;
end;
$$;

create or replace function public.prepare_occurrence_delivery(
  p_occurrence_id text,
  p_reminder_id text,
  p_owner_id uuid,
  p_reminder_revision integer,
  p_scheduled_at timestamptz,
  p_lease_id uuid,
  p_now timestamptz,
  p_stale_before timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1
  from public.reminders
  where id = p_reminder_id
    and owner_id = p_owner_id
    and status = 'active'
    and revision = p_reminder_revision
  for share;
  if not found then
    return false;
  end if;
  insert into public.occurrences(
    id,
    reminder_id,
    owner_id,
    reminder_revision,
    scheduled_at,
    status
  )
  values (
    p_occurrence_id,
    p_reminder_id,
    p_owner_id,
    p_reminder_revision,
    p_scheduled_at,
    'triggered'
  )
  on conflict (id, owner_id) do nothing;
  return public.claim_occurrence_delivery(
    p_occurrence_id,
    p_owner_id,
    p_reminder_id,
    p_reminder_revision,
    p_lease_id,
    p_now,
    p_stale_before
  );
end;
$$;

create or replace function public.renew_occurrence_delivery_lease(
  p_occurrence_id text,
  p_owner_id uuid,
  p_lease_id uuid,
  p_now timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare renewed boolean;
begin
  update public.occurrences
  set acted_at = p_now
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning true into renewed;
  return coalesce(renewed, false);
end;
$$;

create or replace function public.fail_occurrence_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_lease_id uuid,
  p_now timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare failed public.occurrences%rowtype;
begin
  update public.occurrences
  set status = 'delivery-failed',
      delivery_attempts = delivery_attempts + 1,
      next_delivery_attempt_at = case
        when delivery_attempts + 1 >= 5 then null
        else p_now + make_interval(
          mins => least(60, power(2, delivery_attempts)::integer)
        )
      end,
      last_failed_delivery_round_id = p_lease_id,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning * into failed;
  if not found then
    return false;
  end if;
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (failed.reminder_id, failed.id, failed.owner_id, 'delivery-failed');
  return true;
end;
$$;

create or replace function public.record_occurrence_device_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_device_id text,
  p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare active_occurrence text;
begin
  select id into active_occurrence
  from public.occurrences
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  for update;
  if not found then
    return false;
  end if;
  insert into public.occurrence_device_deliveries(
    occurrence_id, owner_id, device_id, delivered_at
  )
  values (p_occurrence_id, p_owner_id, p_device_id, now())
  on conflict (occurrence_id, owner_id, device_id) do update
    set delivered_at = excluded.delivered_at;
  return true;
end;
$$;

create or replace function public.record_expo_push_ticket(
  p_ticket_id text,
  p_occurrence_id text,
  p_owner_id uuid,
  p_device_id text,
  p_lease_id uuid
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare active_occurrence text;
begin
  select id into active_occurrence
  from public.occurrences
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  for update;
  if not found then
    return false;
  end if;
  insert into public.expo_push_tickets(
    ticket_id, occurrence_id, owner_id, device_id, delivery_round_id
  )
  values (
    p_ticket_id,
    p_occurrence_id,
    p_owner_id,
    p_device_id,
    p_lease_id
  )
  on conflict (ticket_id) do nothing;
  return true;
end;
$$;

create or replace function public.complete_expo_push_ticket(p_ticket_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  ticket public.expo_push_tickets%rowtype;
begin
  delete from public.expo_push_tickets
  where ticket_id = p_ticket_id
  returning * into ticket;
  if not found then
    return false;
  end if;
  insert into public.occurrence_device_deliveries(
    occurrence_id, owner_id, device_id, delivered_at
  )
  values (ticket.occurrence_id, ticket.owner_id, ticket.device_id, now())
  on conflict (occurrence_id, owner_id, device_id) do update
    set delivered_at = excluded.delivered_at;
  return true;
end;
$$;

create or replace function public.fail_expo_push_ticket(
  p_ticket_id text,
  p_disable_device boolean
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  ticket public.expo_push_tickets%rowtype;
  failed public.occurrences%rowtype;
begin
  select * into ticket
  from public.expo_push_tickets
  where ticket_id = p_ticket_id
  for update;
  if not found then
    return false;
  end if;
  select * into failed
  from public.occurrences
  where id = ticket.occurrence_id
    and owner_id = ticket.owner_id
  for update;
  if not found then
    return false;
  end if;
  if p_disable_device then
    delete from public.expo_push_tickets
    where ticket_id = p_ticket_id;
    update public.devices
    set enabled = false, updated_at = now()
    where id = ticket.device_id;
  else
    if failed.status = 'delivering' then
      return false;
    end if;
    delete from public.expo_push_tickets
    where ticket_id = p_ticket_id;
    if failed.status <> 'delivery-failed'
      or failed.delivered_at is not null
      or failed.last_failed_delivery_round_id = ticket.delivery_round_id then
      return true;
    end if;
    update public.occurrences
    set status = 'delivery-failed',
        delivery_attempts = least(delivery_attempts + 1, 5),
        next_delivery_attempt_at = case
          when delivery_attempts + 1 >= 5 then null
          else now() + make_interval(
            mins => least(60, power(2, delivery_attempts)::integer)
          )
        end,
        last_failed_delivery_round_id = ticket.delivery_round_id
    where id = ticket.occurrence_id
      and owner_id = ticket.owner_id
      and status = 'delivery-failed'
      and delivered_at is null
      and last_failed_delivery_round_id is distinct from
        ticket.delivery_round_id
    returning * into failed;
    if found then
      insert into public.history(
        reminder_id, occurrence_id, owner_id, event_type
      )
      values (
        failed.reminder_id,
        failed.id,
        failed.owner_id,
        'delivery-failed'
      );
    end if;
  end if;
  return true;
end;
$$;

create or replace function public.defer_occurrence_delivery(
  p_occurrence_id text,
  p_owner_id uuid,
  p_lease_id uuid,
  p_now timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare deferred boolean;
begin
  update public.occurrences
  set status = 'delivery-failed',
      next_delivery_attempt_at = p_now + interval '1 minute',
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = p_owner_id
    and status = 'delivering'
    and delivery_lease_id = p_lease_id
  returning true into deferred;
  return coalesce(deferred, false);
end;
$$;

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
  if requesting_user is null then
    return false;
  end if;
  if p_event not in ('dismissed', 'postponed') then
    raise exception 'Unsupported occurrence action %', p_event;
  end if;
  if p_event = 'postponed'
    and (
      p_snooze_minutes is null
      or p_snooze_minutes not in (5, 10, 15, 30, 60)
    ) then
    raise exception 'Unsupported snooze duration %', p_snooze_minutes;
  end if;
  update public.occurrences
  set status = p_event::public.occurrence_status,
      acted_at = now(),
      snoozed_until = case
        when p_event = 'postponed'
          then now() + make_interval(mins => p_snooze_minutes)
        else null
      end,
      delivered_at = case when p_event = 'postponed' then null else delivered_at end,
      delivery_attempts = case when p_event = 'postponed' then 0 else delivery_attempts end,
      next_delivery_attempt_at = case when p_event = 'postponed' then null else next_delivery_attempt_at end,
      delivery_lease_id = null
  where id = p_occurrence_id
    and owner_id = requesting_user
    and status in ('triggered', 'delivering', 'delivery-failed')
  returning * into acted;
  if not found then
    return false;
  end if;
  if p_event = 'postponed' then
    delete from public.expo_push_tickets
    where occurrence_id = acted.id and owner_id = acted.owner_id;
    delete from public.occurrence_device_deliveries
    where occurrence_id = acted.id and owner_id = acted.owner_id;
  elsif p_event = 'dismissed' then
    delete from public.expo_push_tickets
    where occurrence_id = acted.id and owner_id = acted.owner_id;
  end if;
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (acted.reminder_id, acted.id, acted.owner_id, p_event::public.occurrence_status);
  return true;
end;
$$;

revoke all on function public.act_on_occurrence(text, text, integer) from public, anon;
grant execute on function public.act_on_occurrence(text, text, integer) to authenticated, service_role;
revoke all on function public.claim_occurrence_delivery(text, uuid, text, integer, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_occurrence_delivery(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.prepare_occurrence_delivery(text, text, uuid, integer, timestamptz, uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.renew_occurrence_delivery_lease(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.fail_occurrence_delivery(text, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.record_occurrence_device_delivery(text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.record_expo_push_ticket(text, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.complete_expo_push_ticket(text) from public, anon, authenticated;
revoke all on function public.fail_expo_push_ticket(text, boolean) from public, anon, authenticated;
revoke all on function public.defer_occurrence_delivery(text, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_occurrence_delivery(text, uuid, text, integer, uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.complete_occurrence_delivery(text, uuid, uuid, timestamptz) to service_role;
grant execute on function public.prepare_occurrence_delivery(text, text, uuid, integer, timestamptz, uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.renew_occurrence_delivery_lease(text, uuid, uuid, timestamptz) to service_role;
grant execute on function public.fail_occurrence_delivery(text, uuid, uuid, timestamptz) to service_role;
grant execute on function public.record_occurrence_device_delivery(text, uuid, text, uuid) to service_role;
grant execute on function public.record_expo_push_ticket(text, text, uuid, text, uuid) to service_role;
grant execute on function public.complete_expo_push_ticket(text) to service_role;
grant execute on function public.fail_expo_push_ticket(text, boolean) to service_role;
grant execute on function public.defer_occurrence_delivery(text, uuid, uuid, timestamptz) to service_role;
