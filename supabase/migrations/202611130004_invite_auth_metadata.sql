-- Supabase Auth can write custom app metadata after inserting the user row.
create trigger register_invited_athlete_metadata after update of raw_app_meta_data on auth.users
  for each row when (
    new.raw_app_meta_data ? 'lippolis_invite'
    and (old.raw_app_meta_data ->> 'lippolis_invite') is distinct from (new.raw_app_meta_data ->> 'lippolis_invite')
  ) execute function private.register_invited_athlete();
