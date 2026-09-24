alter table public.occurrences add column delivered_at timestamptz;
alter type public.occurrence_status add value if not exists 'delivering' after 'triggered';

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
  p_scheduled_at timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.occurrences(id, reminder_id, owner_id, scheduled_at, status)
  values (p_occurrence_id, p_reminder_id, p_owner_id, p_scheduled_at, 'missed');
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (p_reminder_id, p_occurrence_id, p_owner_id, 'missed');
  return true;
exception
  when unique_violation then
    return false;
end;
$$;

revoke all on function public.record_missed_occurrence(text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.record_missed_occurrence(text, text, uuid, timestamptz) to service_role;

create or replace function public.act_on_occurrence(
  p_occurrence_id text,
  p_event text,
  p_snoozed_until timestamptz
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare acted public.occurrences%rowtype;
begin
  if p_event not in ('dismissed', 'postponed') then
    raise exception 'Unsupported occurrence action %', p_event;
  end if;
  if p_event = 'postponed' and (p_snoozed_until is null or p_snoozed_until <= now()) then
    raise exception 'Postponed occurrences require a future snooze time';
  end if;
  update public.occurrences
  set status = p_event::public.occurrence_status,
      acted_at = now(),
      snoozed_until = case when p_event = 'postponed' then p_snoozed_until else null end
  where id = p_occurrence_id and status = 'triggered'
  returning * into acted;
  if not found then
    return false;
  end if;
  insert into public.history(reminder_id, occurrence_id, owner_id, event_type)
  values (acted.reminder_id, acted.id, acted.owner_id, p_event::public.occurrence_status);
  return true;
end;
$$;

revoke all on function public.act_on_occurrence(text, text, timestamptz) from public, anon;
grant execute on function public.act_on_occurrence(text, text, timestamptz) to authenticated, service_role;
