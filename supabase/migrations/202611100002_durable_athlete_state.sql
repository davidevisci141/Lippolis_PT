-- Merge safely the athlete's offline-first snapshots. Historical records written by
-- the PT or another device must survive a stale full-snapshot upload from a client.
create or replace function private.merge_snapshot_array(p_current jsonb, p_incoming jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with items as (
    select value as item, 0 as source, ordinality as position
      from jsonb_array_elements(case when jsonb_typeof(p_current) = 'array' then p_current else '[]'::jsonb end) with ordinality
    union all
    select value as item, 1 as source, ordinality as position
      from jsonb_array_elements(case when jsonb_typeof(p_incoming) = 'array' then p_incoming else '[]'::jsonb end) with ordinality
  ), latest as (
    select distinct on (coalesce(item ->> 'id', item ->> 'measuredAt', item ->> 'ts', item::text)) item, source, position
      from items
      order by coalesce(item ->> 'id', item ->> 'measuredAt', item ->> 'ts', item::text), source desc, position desc
  )
  select coalesce(jsonb_agg(item order by source, position), '[]'::jsonb) from latest;
$$;
revoke all on function private.merge_snapshot_array(jsonb, jsonb) from public, anon, authenticated;

create or replace function private.merge_metric_array(p_current jsonb, p_incoming jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with current_items as (
    select value as item from jsonb_array_elements(case when jsonb_typeof(p_current) = 'array' then p_current else '[]'::jsonb end)
  ), incoming_items as (
    select value as item from jsonb_array_elements(case when jsonb_typeof(p_incoming) = 'array' then p_incoming else '[]'::jsonb end)
  ), names as (
    select item ->> 'nome' as metric_name from current_items
    union select item ->> 'nome' as metric_name from incoming_items
  ), merged as (
    select names.metric_name,
      coalesce(current_items.item, '{}'::jsonb) || coalesce(incoming_items.item, '{}'::jsonb) as item,
      private.merge_snapshot_array(current_items.item -> 'dati', incoming_items.item -> 'dati') as data
    from names
    left join current_items on current_items.item ->> 'nome' = names.metric_name
    left join incoming_items on incoming_items.item ->> 'nome' = names.metric_name
  )
  select coalesce(jsonb_agg(jsonb_set(item, '{dati}', data, true) order by metric_name), '[]'::jsonb) from merged;
$$;
revoke all on function private.merge_metric_array(jsonb, jsonb) from public, anon, authenticated;

create or replace function public.save_athlete_state(p_expected_revision integer, p_snapshot jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_next integer;
  v_current jsonb;
  v_current_revision integer;
  v_snapshot jsonb;
  v_key text;
begin
  if not private.is_active_athlete(auth.uid()) then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;

  select snapshot, revision into v_current, v_current_revision
    from public.athlete_states where user_id = auth.uid() for update;
  if found then
    if v_current_revision <> p_expected_revision then
      raise exception 'STATE_CONFLICT' using errcode = '40001';
    end if;

    v_snapshot := coalesce(p_snapshot, '{}'::jsonb);
    foreach v_key in array array['bia', 'sessioni', 'pesi', 'progressi'] loop
      v_snapshot := jsonb_set(v_snapshot, array[v_key], private.merge_snapshot_array(v_current -> v_key, v_snapshot -> v_key), true);
    end loop;
    v_snapshot := jsonb_set(v_snapshot, '{metriche}', private.merge_metric_array(v_current -> 'metriche', v_snapshot -> 'metriche'), true);
    foreach v_key in array array['giornate', 'statoSett', 'noteSessione'] loop
      v_snapshot := jsonb_set(v_snapshot, array[v_key], coalesce(v_current -> v_key, '{}'::jsonb) || coalesce(v_snapshot -> v_key, '{}'::jsonb), true);
    end loop;

    update public.athlete_states
      set snapshot = v_snapshot, revision = revision + 1, updated_at = now()
      where user_id = auth.uid()
      returning revision into v_next;
    return v_next;
  end if;

  if p_expected_revision = 0 then
    insert into public.athlete_states(user_id, snapshot, revision)
      values (auth.uid(), coalesce(p_snapshot, '{}'::jsonb), 1)
      on conflict (user_id) do nothing returning revision into v_next;
    if found then return v_next; end if;
  end if;

  raise exception 'STATE_CONFLICT' using errcode = '40001';
end;
$$;
revoke all on function public.save_athlete_state(integer, jsonb) from public, anon;
grant execute on function public.save_athlete_state(integer, jsonb) to authenticated;
