alter table public.occurrences add column delivered_at timestamptz;

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
  update public.occurrences
  set status = p_event::public.occurrence_status,
      acted_at = now(),
      snoozed_until = p_snoozed_until
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
