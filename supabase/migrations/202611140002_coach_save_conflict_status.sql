-- A stale revision is an HTTP conflict. PostgREST must return it to the caller.
create or replace function public.save_program_draft(
  p_coach_id uuid,
  p_athlete_id uuid,
  p_draft_id uuid,
  p_expected_revision integer,
  p_program jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.program_drafts%rowtype;
  v_revision integer;
begin
  if not private.is_active_coach(p_coach_id) or not private.coach_owns_athlete(p_coach_id, p_athlete_id) then
    raise exception 'NOT_AUTHORIZED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_program) <> 'object' then raise exception 'INVALID_PROGRAM' using errcode = '22023'; end if;

  if p_draft_id is null then
    if coalesce(p_expected_revision, 0) <> 0 then raise exception 'DRAFT_CONFLICT' using errcode = 'PT409'; end if;
    insert into public.program_drafts(coach_id, athlete_id, program, revision, status)
      values (p_coach_id, p_athlete_id, p_program, 1, 'draft')
      returning * into v_draft;
    insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
      values (p_coach_id, p_athlete_id, v_draft.id, 'draft_created', jsonb_build_object('revision', 1));
    return jsonb_build_object('draftId', v_draft.id, 'revision', v_draft.revision);
  end if;

  select * into v_draft from public.program_drafts
    where id = p_draft_id and coach_id = p_coach_id and athlete_id = p_athlete_id
    for update;
  if not found or v_draft.status <> 'draft' then raise exception 'DRAFT_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if v_draft.revision <> p_expected_revision then raise exception 'DRAFT_CONFLICT' using errcode = 'PT409'; end if;
  update public.program_drafts
    set program = p_program, revision = revision + 1, updated_at = now()
    where id = p_draft_id returning revision into v_revision;
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach_id, p_athlete_id, p_draft_id, 'draft_updated', jsonb_build_object('revision', v_revision));
  return jsonb_build_object('draftId', p_draft_id, 'revision', v_revision);
end;
$$;

create or replace function public.publish_program(p_coach_id uuid, p_athlete_id uuid, p_draft_id uuid, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_draft public.program_drafts%rowtype;
  v_current public.programs%rowtype;
  v_version uuid := gen_random_uuid();
  v_revision integer;
begin
  if not private.coach_owns_athlete(p_coach_id, p_athlete_id) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into v_draft from public.program_drafts
    where id = p_draft_id and coach_id = p_coach_id and athlete_id = p_athlete_id for update;
  if not found then raise exception 'DRAFT_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if v_draft.status = 'published' and v_draft.published_version_id is not null and v_draft.revision = p_expected_revision then
    select * into v_current from public.programs where athlete_id = p_athlete_id;
    if not found or v_current.version_id <> v_draft.published_version_id then raise exception 'DRAFT_SUPERSEDED' using errcode = 'PT409'; end if;
    return jsonb_build_object('versionId', v_draft.published_version_id, 'revision', coalesce(v_current.revision, 1));
  end if;
  if v_draft.status <> 'draft' then raise exception 'DRAFT_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if v_draft.revision <> p_expected_revision then raise exception 'DRAFT_CONFLICT' using errcode = 'PT409'; end if;
  select * into v_current from public.programs where athlete_id = p_athlete_id for update;
  if found then
    insert into public.program_versions(id, athlete_id, program, revision, coach_id, published_at)
      values (v_current.version_id, v_current.athlete_id, v_current.program, v_current.revision, v_current.coach_id, v_current.published_at)
      on conflict (id) do nothing;
    v_revision := v_current.revision + 1;
  else v_revision := 1; end if;
  insert into public.programs(athlete_id, program, version_id, revision, coach_id, published_at, updated_at)
    values (p_athlete_id, v_draft.program, v_version, v_revision, p_coach_id, now(), now())
    on conflict (athlete_id) do update set program = excluded.program, version_id = excluded.version_id,
      revision = excluded.revision, coach_id = excluded.coach_id, published_at = excluded.published_at, updated_at = excluded.updated_at;
  update public.program_drafts set status = 'published', published_version_id = v_version, published_at = now(), updated_at = now() where id = p_draft_id;
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach_id, p_athlete_id, p_draft_id, 'published', jsonb_build_object('versionId', v_version, 'revision', v_revision));
  return jsonb_build_object('versionId', v_version, 'revision', v_revision);
end;
$$;

create or replace function public.save_client_nutrition(p_athlete_id uuid, p_expected_revision integer, p_plan jsonb, p_publish boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_draft public.nutrition_plans; v_published public.nutrition_plans;
begin
  if not private.coach_owns_athlete(auth.uid(), p_athlete_id) then
    raise exception using errcode='42501', message='Cliente non autorizzato.';
  end if;
  if not private.valid_nutrition_plan(p_plan) or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode='22023', message='Controlla i dati dei consigli alimentari.';
  end if;
  if p_publish and btrim(p_plan->>'notes') = '' and jsonb_array_length(p_plan->'meals') = 0 then
    raise exception using errcode='22023', message='Aggiungi almeno un consiglio o un pasto.';
  end if;
  if p_expected_revision = 0 then
    insert into public.nutrition_plans(athlete_id, status, plan)
    values (p_athlete_id, 'draft', p_plan) on conflict do nothing returning * into v_draft;
  else
    update public.nutrition_plans set plan = p_plan, revision = revision + 1, updated_at = now()
    where athlete_id = p_athlete_id and status = 'draft' and revision = p_expected_revision returning * into v_draft;
  end if;
  if v_draft.athlete_id is null then
    raise exception using errcode='PT409', message='La bozza è stata aggiornata. Ricaricala prima di salvare.';
  end if;
  if p_publish then
    insert into public.nutrition_plans(athlete_id, status, revision, plan)
    values (p_athlete_id, 'published', v_draft.revision, v_draft.plan)
    on conflict (athlete_id, status) do update
      set plan=excluded.plan, revision=excluded.revision, updated_at=now()
    returning * into v_published;
  end if;
  return jsonb_build_object('draftRevision', v_draft.revision, 'publishedRevision', v_published.revision);
end;
$$;

create or replace function public.save_coach_workspace(p_expected integer, p_content jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_actor uuid := auth.uid(); v_revision integer;
begin
  if not private.is_active_coach(v_actor) then raise exception using errcode='42501', message='Accesso PT richiesto'; end if;
  if p_expected = 0 then
    insert into public.coach_workspaces(coach_id,content) values(v_actor,p_content)
      on conflict do nothing returning revision into v_revision;
  else
    update public.coach_workspaces set content=p_content, revision=revision+1, updated_at=now()
      where coach_id=v_actor and revision=p_expected returning revision into v_revision;
  end if;
  if v_revision is null then raise exception using errcode='PT409', message='Workspace aggiornato altrove. Ricarica prima di salvare.'; end if;
  return v_revision;
end;
$$;

create or replace function public.save_coach_client_section(p_athlete uuid, p_section text, p_expected integer, p_content jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_actor uuid := auth.uid(); v_revision integer;
begin
  if not private.coach_owns_athlete(v_actor,p_athlete) then raise exception using errcode='42501', message='Cliente non autorizzato'; end if;
  if p_expected = 0 then
    insert into public.coach_client_sections(athlete_id,section,content) values(p_athlete,p_section,p_content)
      on conflict do nothing returning revision into v_revision;
  else
    update public.coach_client_sections set content=p_content, revision=revision+1, updated_at=now()
      where athlete_id=p_athlete and section=p_section and revision=p_expected returning revision into v_revision;
  end if;
  if v_revision is null then raise exception using errcode='PT409', message='Dati aggiornati altrove. Ricarica la sezione.'; end if;
  return v_revision;
end;
$$;
