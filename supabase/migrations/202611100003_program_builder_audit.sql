create table if not exists public.program_audit_log (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  draft_id uuid references public.program_drafts(id) on delete set null,
  action text not null check (action in ('draft_created', 'draft_updated', 'draft_archived', 'published')),
  diff jsonb not null default '{}'::jsonb check (jsonb_typeof(diff) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists program_audit_log_athlete_idx on public.program_audit_log (athlete_id, created_at desc);
create index if not exists program_audit_log_draft_idx on public.program_audit_log (draft_id, created_at desc);
alter table public.program_audit_log enable row level security;
revoke all on public.program_audit_log from public, anon, authenticated;
grant all on public.program_audit_log to service_role;

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
    if coalesce(p_expected_revision, 0) <> 0 then raise exception 'DRAFT_CONFLICT' using errcode = '40001'; end if;
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
  if v_draft.revision <> p_expected_revision then raise exception 'DRAFT_CONFLICT' using errcode = '40001'; end if;
  update public.program_drafts
    set program = p_program, revision = revision + 1, updated_at = now()
    where id = p_draft_id returning revision into v_revision;
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach_id, p_athlete_id, p_draft_id, 'draft_updated', jsonb_build_object('revision', v_revision));
  return jsonb_build_object('draftId', p_draft_id, 'revision', v_revision);
end;
$$;
revoke all on function public.save_program_draft(uuid, uuid, uuid, integer, jsonb) from public, anon, authenticated;
grant execute on function public.save_program_draft(uuid, uuid, uuid, integer, jsonb) to service_role;

create or replace function public.archive_program_draft(p_coach_id uuid, p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_draft public.program_drafts%rowtype;
begin
  if not private.is_active_coach(p_coach_id) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into v_draft from public.program_drafts where id = p_draft_id and coach_id = p_coach_id for update;
  if not found or v_draft.status <> 'draft' then raise exception 'DRAFT_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if not private.coach_owns_athlete(p_coach_id, v_draft.athlete_id) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  update public.program_drafts set status = 'archived', archived_at = now(), updated_at = now() where id = p_draft_id;
  insert into public.program_audit_log(coach_id, athlete_id, draft_id, action, diff)
    values (p_coach_id, v_draft.athlete_id, p_draft_id, 'draft_archived', jsonb_build_object('revision', v_draft.revision));
  return jsonb_build_object('archived', true, 'draftId', p_draft_id);
end;
$$;
revoke all on function public.archive_program_draft(uuid, uuid) from public, anon, authenticated;
grant execute on function public.archive_program_draft(uuid, uuid) to service_role;

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
    if not found or v_current.version_id <> v_draft.published_version_id then raise exception 'DRAFT_SUPERSEDED' using errcode = '40001'; end if;
    return jsonb_build_object('versionId', v_draft.published_version_id, 'revision', coalesce(v_current.revision, 1));
  end if;
  if v_draft.status <> 'draft' then raise exception 'DRAFT_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if v_draft.revision <> p_expected_revision then raise exception 'DRAFT_CONFLICT' using errcode = '40001'; end if;
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
revoke all on function public.publish_program(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.publish_program(uuid, uuid, uuid, integer) to service_role;
