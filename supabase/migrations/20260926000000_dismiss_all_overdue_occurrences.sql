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
    and (
      (
        p_event = 'dismissed'
        and status in (
          'scheduled',
          'triggered',
          'delivering',
          'postponed',
          'missed',
          'delivery-failed'
        )
      )
      or (
        p_event = 'postponed'
        and status in ('triggered', 'delivering', 'delivery-failed')
      )
    )
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
