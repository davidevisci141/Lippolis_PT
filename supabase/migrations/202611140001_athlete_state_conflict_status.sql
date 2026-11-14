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
