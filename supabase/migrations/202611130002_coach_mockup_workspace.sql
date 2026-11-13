create table public.coach_workspaces (
  coach_id uuid primary key references public.profiles(id) on delete cascade,
  revision integer not null default 1 check (revision > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 3000000),
  updated_at timestamptz not null default now()
);
create table public.coach_client_sections (
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  section text not null check (section in ('nutrition','progress','documents','questionnaires','metrics','agenda','subscriptions','loads')),
  revision integer not null default 1 check (revision > 0),
  content jsonb not null check (jsonb_typeof(content) = 'object' and octet_length(content::text) <= 500000),
  updated_at timestamptz not null default now(),
  primary key(athlete_id, section)
);
alter table public.coach_workspaces enable row level security;
alter table public.coach_client_sections enable row level security;
create policy coach_workspace_read on public.coach_workspaces for select to authenticated
  using (coach_id = (select auth.uid()) and private.is_active_coach((select auth.uid())));
create policy coach_client_sections_read on public.coach_client_sections for select to authenticated
  using (private.can_read_athlete((select auth.uid()), athlete_id));
revoke all on public.coach_workspaces, public.coach_client_sections from public, anon, authenticated;
grant select on public.coach_workspaces, public.coach_client_sections to authenticated;

create function public.save_coach_workspace(p_expected integer, p_content jsonb)
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
  if v_revision is null then raise exception using errcode='40001', message='Workspace aggiornato altrove. Ricarica prima di salvare.'; end if;
  return v_revision;
end;
$$;

create function public.save_coach_client_section(p_athlete uuid, p_section text, p_expected integer, p_content jsonb)
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
  if v_revision is null then raise exception using errcode='40001', message='Dati aggiornati altrove. Ricarica la sezione.'; end if;
  return v_revision;
end;
$$;

create function public.answer_coach_questionnaire(p_questionnaire uuid, p_answers jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare v_actor uuid := auth.uid(); v_content jsonb; v_form jsonb; v_index integer; v_revision integer;
begin
  if not private.is_active_athlete(v_actor) then raise exception using errcode='42501', message='Accesso cliente richiesto'; end if;
  if jsonb_typeof(p_answers) is distinct from 'array' or octet_length(p_answers::text)>16000
     then raise exception using errcode='22023', message='Risposte non valide'; end if;
  select content into v_content from public.coach_client_sections where athlete_id=v_actor and section='questionnaires' for update;
  select value, ordinality::integer - 1 into v_form,v_index
    from jsonb_array_elements(coalesce(v_content->'items','[]'::jsonb)) with ordinality
    where value->>'id'=p_questionnaire::text;
  if v_index is null or jsonb_typeof(v_form->'answers')='array' then raise exception using errcode='22023', message='Questionario non disponibile'; end if;
  if jsonb_array_length(p_answers) <> jsonb_array_length(v_form->'questions')
     or exists(select 1 from jsonb_array_elements(p_answers) a where jsonb_typeof(a)<>'string' or length(btrim(a #>> '{}')) not between 1 and 1000)
     then raise exception using errcode='22023', message='Completa tutte le risposte'; end if;
  update public.coach_client_sections set revision=revision+1, updated_at=now(),
    content=jsonb_set(v_content,array['items',v_index::text],v_form || jsonb_build_object('answers',p_answers,'answeredAt',now()))
    where athlete_id=v_actor and section='questionnaires' returning revision into v_revision;
  return v_revision;
end;
$$;
revoke all on function public.save_coach_workspace(integer,jsonb), public.save_coach_client_section(uuid,text,integer,jsonb), public.answer_coach_questionnaire(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.save_coach_workspace(integer,jsonb), public.save_coach_client_section(uuid,text,integer,jsonb), public.answer_coach_questionnaire(uuid,jsonb) to authenticated;
alter publication supabase_realtime add table public.coach_client_sections;

create function private.coach_attachment_owner(p_name text)
returns uuid language sql immutable set search_path='' as $$
  select case when p_name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|txt|jpg|png|webp|mp4|webm)$'
    then split_part(p_name,'/',1)::uuid end
$$;
revoke all on function private.coach_attachment_owner(text) from public, anon;
grant execute on function private.coach_attachment_owner(text) to authenticated, service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('coach-client-files','coach-client-files',false,52428800,array['application/pdf','text/plain','image/jpeg','image/png','image/webp','video/mp4','video/webm'])
on conflict(id) do nothing;
create policy coach_client_files_read on storage.objects for select to authenticated
using (bucket_id='coach-client-files' and private.can_read_athlete((select auth.uid()),private.coach_attachment_owner(name)));
create policy coach_client_files_upload on storage.objects for insert to authenticated
with check (bucket_id='coach-client-files' and private.coach_owns_athlete((select auth.uid()),private.coach_attachment_owner(name)));
create policy coach_client_files_delete on storage.objects for delete to authenticated
using (bucket_id='coach-client-files' and private.coach_owns_athlete((select auth.uid()),private.coach_attachment_owner(name)));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('coach-exercise-files','coach-exercise-files',false,52428800,array['image/jpeg','image/png','image/webp','video/mp4','video/webm'])
on conflict(id) do nothing;
create policy coach_exercise_files_read on storage.objects for select to authenticated
using (bucket_id='coach-exercise-files' and (
  (private.coach_attachment_owner(name)=(select auth.uid()) and private.is_active_coach((select auth.uid())))
  or (private.is_active_athlete((select auth.uid())) and exists (
    select 1 from public.programs p where p.athlete_id=(select auth.uid()) and p.coach_id=private.coach_attachment_owner(name)
      and jsonb_path_exists(p.program,'$.settimane[*].giorni[*].blocks[*].exercises[*].legacyFields.videoStoragePath ? (@ == $path)',jsonb_build_object('path',name))
  ))
));
create policy coach_exercise_files_upload on storage.objects for insert to authenticated
with check (bucket_id='coach-exercise-files' and private.is_active_coach((select auth.uid())) and private.coach_attachment_owner(name)=(select auth.uid()));
