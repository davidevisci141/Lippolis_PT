-- Allow private storage paths for normalized JPEG previews next to BIA originals.
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
