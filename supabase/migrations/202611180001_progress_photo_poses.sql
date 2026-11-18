-- Foto dei progressi caricate insieme: <atleta>/<lotto>-athlete-progress-<fronte|lato|retro>.jpg.
-- Il formato precedente (<uuid>-athlete-progress.jpg) resta valido. Le regole esistenti usano già questa funzione.
create or replace function private.athlete_progress_photo_owner(p_name text)
returns uuid
language sql immutable security definer set search_path = '' as $$
  select case when p_name ~* '-athlete-progress(-(fronte|lato|retro))?[.]jpg$'
    then private.coach_attachment_owner(regexp_replace(p_name, '-athlete-progress(-(fronte|lato|retro))?[.]jpg$', '.jpg', 'i')) end
$$;
revoke all on function private.athlete_progress_photo_owner(text) from public, anon;
grant execute on function private.athlete_progress_photo_owner(text) to authenticated, service_role;
