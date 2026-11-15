-- Gestione delle schede dal pannello coach:
--  - eliminare una scheda pubblicata (se è quella attiva il cliente resta senza scheda);
--  - eliminare un programma che esiste solo nello storico allenamenti (le sue sedute);
--  - aggiungere una scheda già conclusa (storico, senza toccare quella attiva).
alter table public.program_audit_log drop constraint if exists program_audit_log_action_check;
alter table public.program_audit_log add constraint program_audit_log_action_check
  check (action in ('draft_created', 'draft_updated', 'draft_archived', 'published', 'program_deleted', 'history_deleted', 'program_archived_import'));

create or replace function private.union_ids(p_a jsonb, p_b jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(distinct v.value), '[]'::jsonb) from (
    select value from jsonb_array_elements_text(case when jsonb_typeof(p_a) = 'array' then p_a else '[]'::jsonb end)
    union select value from jsonb_array_elements_text(case when jsonb_typeof(p_b) = 'array' then p_b else '[]'::jsonb end)
  ) v(value);
$$;
revoke all on function private.union_ids(jsonb, jsonb) from public, anon, authenticated;

create or replace function private.without_ids(p_items jsonb, p_ids jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(e.value order by e.ord), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality e(value, ord)
    where not coalesce(e.value ->> 'id', '') in (select jsonb_array_elements_text(case when jsonb_typeof(p_ids) = 'array' then p_ids else '[]'::jsonb end));
$$;
revoke all on function private.without_ids(jsonb, jsonb) from public, anon, authenticated;

create or replace function public.save_athlete_state(p_expected_revision integer, p_snapshot jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_next integer;
  v_current jsonb;
  v_current_revision integer;
  v_snapshot jsonb := coalesce(p_snapshot, '{}'::jsonb) - 'bia';
  v_key text;
begin
  if not private.is_active_athlete(auth.uid()) then
    raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501';
  end if;
  select snapshot, revision into v_current, v_current_revision
    from public.athlete_states where user_id = auth.uid() for update;
  if found then
    -- PostgREST can retry SQLSTATE 40001 indefinitely. Only the client can
    -- reconcile an outdated revision with the latest snapshot.
    if v_current_revision is distinct from p_expected_revision then
      raise sqlstate 'PT409' using message = 'STATE_CONFLICT';
    end if;
    v_snapshot := jsonb_set(v_snapshot, '{bia}', coalesce(v_current -> 'bia', '[]'::jsonb), true);
    foreach v_key in array array['sessioni','pesi','progressi'] loop
      v_snapshot := jsonb_set(v_snapshot,array[v_key],private.merge_snapshot_array(v_current -> v_key,v_snapshot -> v_key),true);
    end loop;
    -- Sedute eliminate dal PT: restano eliminate anche se il telefono ne ha ancora una copia.
    v_snapshot := jsonb_set(v_snapshot,'{sessioniEliminate}',private.union_ids(v_current -> 'sessioniEliminate',v_snapshot -> 'sessioniEliminate'),true);
    v_snapshot := jsonb_set(v_snapshot,'{sessioni}',private.without_ids(v_snapshot -> 'sessioni',v_snapshot -> 'sessioniEliminate'),true);
    v_snapshot := jsonb_set(v_snapshot,'{metriche}',private.merge_metric_array(v_current -> 'metriche',v_snapshot -> 'metriche'),true);
    foreach v_key in array array['giornate','statoSett','noteSessione'] loop
      v_snapshot := jsonb_set(v_snapshot,array[v_key],coalesce(v_current -> v_key,'{}'::jsonb) || coalesce(v_snapshot -> v_key,'{}'::jsonb),true);
    end loop;
    update public.athlete_states set snapshot=v_snapshot,revision=revision+1,updated_at=now()
      where user_id=auth.uid() returning revision into v_next;
    return v_next;
  end if;
  if p_expected_revision = 0 then
    insert into public.athlete_states(user_id,snapshot,revision)
      values (auth.uid(),v_snapshot || '{"bia":[]}'::jsonb,1)
      on conflict (user_id) do nothing returning revision into v_next;
    if found then return v_next; end if;
  end if;
  raise sqlstate 'PT409' using message = 'STATE_CONFLICT';
end;
$$;

create or replace function public.coach_delete_program_version(p_coach uuid, p_athlete uuid, p_version uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_active boolean := false;
  v_found boolean := false;
begin
  if not private.is_active_coach(p_coach) or not private.coach_owns_athlete(p_coach, p_athlete) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  delete from public.programs where athlete_id = p_athlete and version_id = p_version;
  v_active := found;
  delete from public.program_versions where athlete_id = p_athlete and id = p_version;
  v_found := found or v_active;
  if not v_found then raise exception 'PROGRAM_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach, p_athlete, null, 'program_deleted', jsonb_build_object('versionId', p_version, 'active', v_active));
  return jsonb_build_object('deleted', true, 'active', v_active);
end;
$$;
revoke all on function public.coach_delete_program_version(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.coach_delete_program_version(uuid, uuid, uuid) to service_role;

create or replace function public.coach_delete_history_program(p_coach uuid, p_athlete uuid, p_prog text, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_snapshot jsonb;
  v_ids jsonb;
begin
  if not private.is_active_coach(p_coach) or not private.coach_owns_athlete(p_coach, p_athlete) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  select snapshot into v_snapshot from public.athlete_states where user_id = p_athlete for update;
  if not found then return jsonb_build_object('deleted', 0); end if;
  select coalesce(jsonb_agg(e.value ->> 'id'), '[]'::jsonb) into v_ids
    from jsonb_array_elements(coalesce(v_snapshot -> 'sessioni', '[]'::jsonb)) e
    where coalesce(e.value ->> 'id', '') <> ''
      and lower(trim(coalesce(e.value ->> 'prog', ''))) = lower(trim(p_prog))
      and (e.value ->> 'ts') ~ '^[0-9]+(\.[0-9]+)?$'
      and (to_timestamp((e.value ->> 'ts')::numeric / 1000) at time zone 'Europe/Rome')::date between p_from and p_to;
  if jsonb_array_length(v_ids) = 0 then return jsonb_build_object('deleted', 0); end if;
  v_snapshot := jsonb_set(v_snapshot, '{sessioniEliminate}', private.union_ids(v_snapshot -> 'sessioniEliminate', v_ids), true);
  v_snapshot := jsonb_set(v_snapshot, '{sessioni}', private.without_ids(v_snapshot -> 'sessioni', v_ids), true);
  update public.athlete_states set snapshot = v_snapshot, revision = revision + 1, updated_at = now() where user_id = p_athlete;
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach, p_athlete, null, 'history_deleted', jsonb_build_object('prog', p_prog, 'sessions', jsonb_array_length(v_ids)));
  return jsonb_build_object('deleted', jsonb_array_length(v_ids));
end;
$$;
revoke all on function public.coach_delete_history_program(uuid, uuid, text, date, date) from public, anon, authenticated;
grant execute on function public.coach_delete_history_program(uuid, uuid, text, date, date) to service_role;

create or replace function public.coach_add_concluded_program(p_coach uuid, p_athlete uuid, p_program jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := gen_random_uuid();
begin
  if not private.is_active_coach(p_coach) or not private.coach_owns_athlete(p_coach, p_athlete) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_program) <> 'object' then raise exception 'INVALID_PROGRAM' using errcode = '22023'; end if;
  insert into public.program_versions(id, athlete_id, program, revision, coach_id, published_at, archived_at)
    values (v_id, p_athlete, p_program, 1, p_coach, now(), now());
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach, p_athlete, null, 'program_archived_import', jsonb_build_object('versionId', v_id));
  return jsonb_build_object('versionId', v_id);
end;
$$;
revoke all on function public.coach_add_concluded_program(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.coach_add_concluded_program(uuid, uuid, jsonb) to service_role;
