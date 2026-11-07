create extension if not exists pgcrypto;
create schema if not exists private;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null check (char_length(first_name) between 1 and 60),
  last_name text not null check (char_length(last_name) between 1 and 60),
  display_name text not null,
  email text not null,
  role text not null check (role in ('coach', 'athlete')),
  trainer_id uuid references public.profiles(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleting')),
  onboarding_complete boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  onboarding_completed_at timestamptz,
  suspended_at timestamptz,
  reactivated_at timestamptz,
  constraint athlete_has_trainer check ((role = 'coach' and trainer_id is null) or (role = 'athlete' and trainer_id is not null))
);
create unique index profiles_email_unique on public.profiles (lower(email));
create index profiles_trainer_idx on public.profiles (trainer_id, role, last_name);

create table public.athlete_states (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  snapshot jsonb not null default '{}'::jsonb,
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table public.programs (
  athlete_id uuid primary key references public.profiles(id) on delete cascade,
  program jsonb not null,
  version_id uuid not null default gen_random_uuid(),
  revision integer not null default 1 check (revision > 0),
  coach_id uuid not null references public.profiles(id),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.program_versions (
  id uuid primary key,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  program jsonb not null,
  revision integer not null,
  coach_id uuid not null references public.profiles(id),
  published_at timestamptz not null,
  archived_at timestamptz not null default now()
);
create index program_versions_athlete_idx on public.program_versions (athlete_id, archived_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  target_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('thread', 'diary', 'deferred')),
  type text not null default 'message' check (char_length(type) between 1 and 40),
  text text not null check (char_length(text) between 1 and 4000),
  metadata jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index messages_athlete_idx on public.messages (athlete_id, created_at);

create table public.program_drafts (
  id uuid primary key default gen_random_uuid(),
  coach_id uuid not null references public.profiles(id) on delete cascade,
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  program jsonb not null,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_version_id uuid,
  published_at timestamptz,
  archived_at timestamptz
);
create index program_drafts_coach_idx on public.program_drafts (coach_id, athlete_id, status, updated_at desc);

create table public.admin_operations (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete set null,
  operation_type text not null,
  idempotency_key text not null,
  status text not null,
  request jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (actor_id, operation_type, idempotency_key)
);

create or replace function private.is_active_coach(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = p_uid and role = 'coach' and status = 'active');
$$;
create or replace function private.is_active_athlete(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = p_uid and role = 'athlete' and status = 'active' and onboarding_complete);
$$;
create or replace function private.coach_owns_athlete(p_coach uuid, p_athlete uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_active_coach(p_coach) and exists(
    select 1 from public.profiles where id = p_athlete and role = 'athlete' and trainer_id = p_coach
  );
$$;
create or replace function private.can_read_athlete(p_user uuid, p_athlete uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (p_user = p_athlete and private.is_active_athlete(p_user)) or private.coach_owns_athlete(p_user, p_athlete);
$$;

alter table public.profiles enable row level security;
alter table public.athlete_states enable row level security;
alter table public.programs enable row level security;
alter table public.program_versions enable row level security;
alter table public.messages enable row level security;
alter table public.program_drafts enable row level security;
alter table public.admin_operations enable row level security;

create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid()) or private.coach_owns_athlete((select auth.uid()), id)
);
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()) and status = 'active')
  with check (id = (select auth.uid()) and status = 'active');

create policy states_select on public.athlete_states for select to authenticated using (private.can_read_athlete((select auth.uid()), user_id));
create policy states_insert on public.athlete_states for insert to authenticated with check (user_id = (select auth.uid()) and private.is_active_athlete((select auth.uid())));
create policy states_update on public.athlete_states for update to authenticated
  using (user_id = (select auth.uid()) and private.is_active_athlete((select auth.uid())))
  with check (user_id = (select auth.uid()));

create policy programs_select on public.programs for select to authenticated using (private.can_read_athlete((select auth.uid()), athlete_id));
create policy versions_select on public.program_versions for select to authenticated using (private.can_read_athlete((select auth.uid()), athlete_id));
create policy drafts_select on public.program_drafts for select to authenticated using (coach_id = (select auth.uid()) and private.is_active_coach((select auth.uid())));

create policy messages_select on public.messages for select to authenticated using (private.can_read_athlete((select auth.uid()), athlete_id));
create policy messages_insert on public.messages for insert to authenticated with check (
  private.can_read_athlete((select auth.uid()), athlete_id)
  and sender_id = (select auth.uid())
  and target_id = athlete_id
  and channel in ('thread', 'diary', 'deferred')
  and char_length(text) between 1 and 4000
);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.athlete_states, public.programs, public.program_versions, public.messages, public.program_drafts to authenticated;
grant update(first_name, last_name, display_name, updated_at) on public.profiles to authenticated;
grant insert(athlete_id, sender_id, target_id, channel, type, text, metadata) on public.messages to authenticated;

create or replace function public.save_athlete_state(p_expected_revision integer, p_snapshot jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_next integer;
begin
  if not private.is_active_athlete(auth.uid()) then raise exception 'ACCOUNT_NOT_ACTIVE' using errcode = '42501'; end if;
  update public.athlete_states
    set snapshot = p_snapshot, revision = revision + 1, updated_at = now()
    where user_id = auth.uid() and revision = p_expected_revision
    returning revision into v_next;
  if found then return v_next; end if;
  if p_expected_revision = 0 then
    insert into public.athlete_states(user_id, snapshot, revision) values (auth.uid(), p_snapshot, 1)
      on conflict (user_id) do nothing returning revision into v_next;
    if found then return v_next; end if;
  end if;
  raise exception 'STATE_CONFLICT' using errcode = '40001';
end;
$$;
revoke all on function public.save_athlete_state(integer, jsonb) from public, anon;
grant execute on function public.save_athlete_state(integer, jsonb) to authenticated;

create or replace function public.publish_program(p_coach_id uuid, p_athlete_id uuid, p_draft_id uuid, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_draft public.program_drafts%rowtype; v_current public.programs%rowtype; v_version uuid := gen_random_uuid(); v_revision integer;
begin
  if not private.coach_owns_athlete(p_coach_id, p_athlete_id) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into v_draft from public.program_drafts where id = p_draft_id and coach_id = p_coach_id and athlete_id = p_athlete_id for update;
  if not found or v_draft.status <> 'draft' then raise exception 'DRAFT_NOT_AVAILABLE' using errcode = 'P0001'; end if;
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
  return jsonb_build_object('versionId', v_version, 'revision', v_revision);
end;
$$;
revoke all on function public.publish_program(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.publish_program(uuid, uuid, uuid, integer) to service_role;

do $$
declare t text;
begin
  foreach t in array array['profiles','athlete_states','programs','program_versions','messages','program_drafts'] loop
    if not exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
