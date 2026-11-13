-- Athlete uploads use a dedicated filename suffix in the existing private bucket.
-- Keeping files directly under the athlete ID also includes them in account deletion.
create function private.athlete_progress_photo_owner(p_name text)
returns uuid
language sql immutable set search_path = '' as $$
  select case when p_name like '%-athlete-progress.jpg'
    then private.coach_attachment_owner(regexp_replace(p_name, '-athlete-progress[.]jpg$', '.jpg')) end
$$;
revoke all on function private.athlete_progress_photo_owner(text) from public, anon;
grant execute on function private.athlete_progress_photo_owner(text) to authenticated, service_role;

create policy athlete_progress_photos_read on storage.objects
for select to authenticated using (
  bucket_id = 'coach-client-files'
  and private.can_read_athlete((select auth.uid()), private.athlete_progress_photo_owner(name))
);

create policy athlete_progress_photos_upload on storage.objects
for insert to authenticated with check (
  bucket_id = 'coach-client-files'
  and private.athlete_progress_photo_owner(name) = (select auth.uid())
  and private.is_active_athlete((select auth.uid()))
);

create policy athlete_progress_photos_delete on storage.objects
for delete to authenticated using (
  bucket_id = 'coach-client-files'
  and private.athlete_progress_photo_owner(name) = (select auth.uid())
  and private.is_active_athlete((select auth.uid()))
);
