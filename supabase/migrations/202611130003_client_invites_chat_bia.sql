begin;

create table private.client_invites (
  token_hash text primary key,
  coach_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz
);
create index client_invites_coach_idx on private.client_invites (coach_id, created_at);

create function public.create_client_invite()
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_coach uuid := auth.uid();
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not private.is_active_coach(v_coach) then
    raise exception 'Invito riservato al PT.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_coach::text, 11));
  if (select count(*) from private.client_invites where coach_id = v_coach and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Troppi inviti generati. Riprova più tardi.';
  end if;
  insert into private.client_invites(token_hash, coach_id)
    values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_coach);
  return v_token;
end;
$$;
revoke all on function public.create_client_invite() from public, anon;
grant execute on function public.create_client_invite() to authenticated;

create function public.client_invite_available(p_hash text)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from private.client_invites
    where token_hash = p_hash and used_at is null and expires_at > now() and private.is_active_coach(coach_id));
$$;
revoke all on function public.client_invite_available(text) from public, anon, authenticated;
grant execute on function public.client_invite_available(text) to service_role;

create function private.register_invited_athlete()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_hash text := new.raw_app_meta_data ->> 'lippolis_invite';
  v_coach uuid;
  v_first text := new.raw_user_meta_data ->> 'first_name';
  v_last text := new.raw_user_meta_data ->> 'last_name';
begin
  if v_hash is null then return new; end if;
  update private.client_invites set used_at = now()
    where token_hash = v_hash and used_at is null and expires_at > now()
      and private.is_active_coach(coach_id)
    returning coach_id into v_coach;
  if not found then raise exception 'INVITE_UNAVAILABLE'; end if;
  insert into public.profiles(id,first_name,last_name,display_name,email,role,trainer_id,onboarding_complete,onboarding_completed_at)
    values(new.id,v_first,v_last,v_first || ' ' || v_last,new.email,'athlete',v_coach,true,now());
  return new;
end;
$$;
revoke all on function private.register_invited_athlete() from public, anon, authenticated;
create trigger register_invited_athlete after insert on auth.users
  for each row when (new.raw_app_meta_data ? 'lippolis_invite') execute function private.register_invited_athlete();

create function public.mark_chat_read(p_athlete uuid, p_messages uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_reader uuid := auth.uid();
begin
  if not private.can_read_athlete(v_reader,p_athlete) or cardinality(p_messages) > 200 then
    raise exception 'Conversazione non disponibile.' using errcode = '42501';
  end if;
  update public.messages set read_at = now()
    where athlete_id = p_athlete and id = any(p_messages)
      and channel = 'thread' and sender_id <> v_reader and read_at is null;
end;
$$;
revoke all on function public.mark_chat_read(uuid,uuid[]) from public, anon;
grant execute on function public.mark_chat_read(uuid,uuid[]) to authenticated;

create index messages_thread_unread_idx on public.messages(athlete_id,sender_id)
  where channel = 'thread' and read_at is null;
create index messages_thread_latest_idx on public.messages(athlete_id,created_at desc,id desc)
  where channel = 'thread';

create function public.coach_chat_inbox()
returns table (athlete_id uuid, latest_text text, latest_at timestamptz, unread bigint)
language sql stable security definer set search_path = '' as $$
  select p.id, latest.text, latest.created_at,
    (select count(*) from public.messages m where m.athlete_id=p.id and m.channel='thread'
      and m.sender_id=p.id and m.read_at is null)
  from public.profiles p
  left join lateral (
    select m.text,m.created_at from public.messages m where m.athlete_id=p.id and m.channel='thread'
    order by m.created_at desc,m.id desc limit 1
  ) latest on true
  where p.trainer_id=auth.uid() and p.role='athlete' and private.is_active_coach(auth.uid());
$$;
revoke all on function public.coach_chat_inbox() from public, anon;
grant execute on function public.coach_chat_inbox() to authenticated;

create function public.athlete_chat_coach_name()
returns text language sql stable security definer set search_path = '' as $$
  select coach.display_name from public.profiles athlete
  join public.profiles coach on coach.id=athlete.trainer_id
  where athlete.id=auth.uid() and private.is_active_athlete(athlete.id);
$$;
revoke all on function public.athlete_chat_coach_name() from public, anon;
grant execute on function public.athlete_chat_coach_name() to authenticated;

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
    if v_current_revision <> p_expected_revision then
      raise exception 'STATE_CONFLICT' using errcode = '40001';
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
  raise exception 'STATE_CONFLICT' using errcode = '40001';
end;
$$;

create table private.deleted_bia_files (
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  record_id text not null,
  paths text[] not null,
  primary key (athlete_id,record_id)
);
create function public.remove_bia_record(p_coach uuid,p_athlete uuid,p_record text)
returns text[] language plpgsql security definer set search_path = '' as $$
declare
  v_snapshot jsonb;
  v_record jsonb;
  v_paths text[];
begin
  if not private.coach_owns_athlete(p_coach,p_athlete) then
    raise exception 'Cliente non assegnato.' using errcode = '42501';
  end if;
  select snapshot into v_snapshot from public.athlete_states where user_id=p_athlete for update;
  select e.value into v_record from jsonb_array_elements(coalesce(v_snapshot -> 'bia','[]')) e
    where e.value ->> 'id'=p_record;
  if not found then
    select paths into v_paths from private.deleted_bia_files where athlete_id=p_athlete and record_id=p_record;
    return v_paths;
  end if;
  select coalesce(array_agg(path),'{}') into v_paths
    from unnest(array[v_record ->> 'reportPath',v_record ->> 'reportPreviewPath']) path
    where private.bia_storage_athlete_id(path)=p_athlete
      and not exists (select 1 from jsonb_array_elements(v_snapshot -> 'bia') e
        where e.value ->> 'id' is distinct from p_record
          and path in (e.value ->> 'reportPath',e.value ->> 'reportPreviewPath'));
  insert into private.deleted_bia_files values(p_athlete,p_record,v_paths)
    on conflict (athlete_id,record_id) do nothing;
  update public.athlete_states
    set snapshot=jsonb_set(snapshot,'{bia}',(select coalesce(jsonb_agg(e.value order by e.ord),'[]')
      from jsonb_array_elements(v_snapshot -> 'bia') with ordinality e(value,ord) where e.value ->> 'id' is distinct from p_record)),
      revision=revision+1,updated_at=now()
    where user_id=p_athlete;
  return v_paths;
end;
$$;
revoke all on function public.remove_bia_record(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.remove_bia_record(uuid,uuid,text) to service_role;

commit;
