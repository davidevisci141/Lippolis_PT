-- Il PT importa lo storico allenamenti (e le pesate) di un suo cliente:
-- sessioni da CoachPlus o dal vecchio APK con i dati solo sul telefono.
-- Le voci si uniscono per id (come fa save_athlete_state): niente va perso,
-- un id già presente viene aggiornato con la versione importata.
-- Le sessioni restano in ordine di data, come le registra l'app.
create or replace function private.sort_by_ts(p_items jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(e.value order by case when e.value ->> 'ts' ~ '^[0-9]+(\.[0-9]+)?$' then (e.value ->> 'ts')::numeric end nulls first, e.ord), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality e(value, ord);
$$;
revoke all on function private.sort_by_ts(jsonb) from public, anon, authenticated;

create or replace function public.coach_import_history(p_coach uuid, p_athlete uuid, p_sessioni jsonb, p_pesi jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_current jsonb;
  v_snapshot jsonb;
  v_revision integer;
  v_prima integer := 0;
begin
  if not private.coach_owns_athlete(p_coach, p_athlete) then
    raise exception 'Cliente non assegnato.' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_sessioni, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_pesi, '[]'::jsonb)) <> 'array' then
    raise exception 'Formato non valido.' using errcode = '22023';
  end if;
  select snapshot into v_current from public.athlete_states where user_id = p_athlete for update;
  if found then
    v_prima := jsonb_array_length(coalesce(v_current -> 'sessioni', '[]'::jsonb));
    v_snapshot := jsonb_set(v_current, '{sessioni}', private.sort_by_ts(private.merge_snapshot_array(v_current -> 'sessioni', p_sessioni)), true);
    v_snapshot := jsonb_set(v_snapshot, '{pesi}', private.sort_by_ts(private.merge_snapshot_array(v_current -> 'pesi', p_pesi)), true);
    update public.athlete_states set snapshot = v_snapshot, revision = revision + 1, updated_at = now()
      where user_id = p_athlete returning revision into v_revision;
  else
    v_snapshot := jsonb_build_object('v', 1, 'sessioni', private.sort_by_ts(private.merge_snapshot_array('[]'::jsonb, p_sessioni)),
                                     'pesi', private.sort_by_ts(private.merge_snapshot_array('[]'::jsonb, p_pesi)), 'bia', '[]'::jsonb);
    insert into public.athlete_states(user_id, snapshot, revision) values (p_athlete, v_snapshot, 1)
      returning revision into v_revision;
  end if;
  return jsonb_build_object('sessioniPrima', v_prima,
                            'sessioniDopo', jsonb_array_length(v_snapshot -> 'sessioni'),
                            'pesiDopo', jsonb_array_length(v_snapshot -> 'pesi'),
                            'revision', v_revision);
end;
$$;
revoke all on function public.coach_import_history(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.coach_import_history(uuid, uuid, jsonb, jsonb) to service_role;
