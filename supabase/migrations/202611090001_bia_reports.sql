-- Original InBody reports live only in this non-public bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bia-reports',
  'bia-reports',
  false,
  15728640,
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.bia_storage_athlete_id(p_name text)
returns uuid
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  if p_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-preview)?\.(jpg|png|webp|heic|pdf)$' then
    return null;
  end if;
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

revoke all on function private.bia_storage_athlete_id(text) from public, anon;
grant execute on function private.bia_storage_athlete_id(text) to authenticated, service_role;

create policy bia_reports_read_assigned on storage.objects
for select to authenticated
using (
  bucket_id = 'bia-reports'
  and private.can_read_athlete((select auth.uid()), private.bia_storage_athlete_id(name))
);

create policy bia_reports_upload_coach on storage.objects
for insert to authenticated
with check (
  bucket_id = 'bia-reports'
  and private.coach_owns_athlete((select auth.uid()), private.bia_storage_athlete_id(name))
);

create policy bia_reports_delete_coach on storage.objects
for delete to authenticated
using (
  bucket_id = 'bia-reports'
  and private.coach_owns_athlete((select auth.uid()), private.bia_storage_athlete_id(name))
);

-- Limit confirmed BIA writes to 10 per coach in any rolling 10-minute window.
create table private.bia_write_events (
  actor_id uuid not null,
  occurred_at timestamptz not null default now()
);
create index bia_write_events_actor_time_idx on private.bia_write_events (actor_id, occurred_at desc);
revoke all on private.bia_write_events from public, anon, authenticated;
grant all on private.bia_write_events to service_role;

create or replace function public.consume_bia_rate_limit(p_actor uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_actor is null then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text, 0));
  delete from private.bia_write_events
    where actor_id = p_actor and occurred_at < now() - interval '1 hour';
  select count(*) into v_count from private.bia_write_events
    where actor_id = p_actor and occurred_at >= now() - interval '10 minutes';
  if v_count >= 10 then
    return false;
  end if;
  insert into private.bia_write_events (actor_id) values (p_actor);
  return true;
end;
$$;
revoke all on function public.consume_bia_rate_limit(uuid) from public, anon, authenticated;
grant execute on function public.consume_bia_rate_limit(uuid) to service_role;
