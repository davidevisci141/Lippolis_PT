-- 1. Crea prima l'utente PT in Supabase > Authentication > Users > Add user.
-- 2. Attiva "Auto Confirm User".
-- 3. Sostituisci email, nome e cognome qui sotto, poi esegui nel SQL Editor.
insert into public.profiles (id, first_name, last_name, display_name, email, role, status, onboarding_complete)
select id, 'NOME_PT', 'COGNOME_PT', 'NOME_PT COGNOME_PT', email, 'coach', 'active', true
from auth.users
where lower(email) = lower('EMAIL_PT_DA_SOSTITUIRE')
on conflict (id) do update set
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  display_name = excluded.display_name,
  email = excluded.email,
  role = 'coach',
  trainer_id = null,
  status = 'active',
  onboarding_complete = true,
  updated_at = now();
