create or replace function public.is_valid_schedule(value jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  fields text[];
  starts_at timestamptz;
  ends_at timestamptz;
  time_count integer;
begin
  if jsonb_typeof(value) <> 'object' then return false; end if;
  if value->>'kind' = 'once' then
    if coalesce(jsonb_typeof(value->'at') = 'string', false) = false then
      return false;
    end if;
    if value ? 'occurrenceLimit' then return false; end if;
    if value->>'at' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then return false; end if;
    perform (value->>'at')::timestamptz;
    return true;
  end if;
  if value->>'kind' = 'daily-times' then
    if coalesce(jsonb_typeof(value->'times') = 'array', false) = false then
      return false;
    end if;
    if jsonb_array_length(value->'times') < 2
      or jsonb_array_length(value->'times') > 24
      or value ?| array['at', 'expression', 'startAt', 'endAt', 'occurrenceLimit'] then
      return false;
    end if;
    if exists (
      select 1
      from jsonb_array_elements(value->'times') as entry(item)
      where jsonb_typeof(item) <> 'string'
        or item #>> '{}' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    ) then
      return false;
    end if;
    select count(distinct item #>> '{}')
    into time_count
    from jsonb_array_elements(value->'times') as entry(item);
    return time_count = jsonb_array_length(value->'times');
  end if;
  if coalesce(value->>'kind' = 'cron', false) = false
    or coalesce(jsonb_typeof(value->'expression') = 'string', false) = false then
    return false;
  end if;
  fields := regexp_split_to_array(trim(value->>'expression'), '\s+');
  if array_length(fields, 1) <> 5
    or not public.is_valid_cron_field(fields[1], 0, 59)
    or not public.is_valid_cron_field(fields[2], 0, 23)
    or not public.is_valid_cron_field(fields[3], 1, 31)
    or not public.is_valid_cron_field(
      fields[4], 1, 12,
      array['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
    )
    or not public.is_valid_cron_field(
      fields[5], 0, 7,
      array['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
    ) then
    return false;
  end if;
  if value ? 'occurrenceLimit' and (
    jsonb_typeof(value->'occurrenceLimit') <> 'number'
    or (value->>'occurrenceLimit')::numeric < 1
    or (value->>'occurrenceLimit')::numeric % 1 <> 0
    or (value->>'occurrenceLimit')::numeric > 9007199254740991
  ) then return false; end if;
  if value ? 'startAt' then
    if jsonb_typeof(value->'startAt') <> 'string' then return false; end if;
    if value->>'startAt' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then return false; end if;
    starts_at := (value->>'startAt')::timestamptz;
  end if;
  if value ? 'endAt' then
    if jsonb_typeof(value->'endAt') <> 'string' then return false; end if;
    if value->>'endAt' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then return false; end if;
    ends_at := (value->>'endAt')::timestamptz;
  end if;
  return starts_at is null or ends_at is null or starts_at <= ends_at;
exception when others then
  return false;
end;
$$;
