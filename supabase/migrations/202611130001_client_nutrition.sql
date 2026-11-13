create or replace function private.valid_nutrition_plan(p_plan jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_meal jsonb;
begin
  if jsonb_typeof(p_plan) is distinct from 'object'
     or jsonb_typeof(p_plan->'title') is distinct from 'string'
     or jsonb_typeof(p_plan->'notes') is distinct from 'string'
     or jsonb_typeof(p_plan->'meals') is distinct from 'array'
     or char_length(p_plan->>'title') not between 1 and 120
     or btrim(p_plan->>'title') = ''
     or char_length(p_plan->>'notes') > 4000
  then return false; end if;
  if jsonb_array_length(p_plan->'meals') > 12 then return false; end if;
  for v_meal in select value from jsonb_array_elements(p_plan->'meals') loop
    if jsonb_typeof(v_meal) is distinct from 'object'
       or jsonb_typeof(v_meal->'label') is distinct from 'string'
       or jsonb_typeof(v_meal->'text') is distinct from 'string'
       or char_length(v_meal->>'label') not between 1 and 80
       or char_length(v_meal->>'text') not between 1 and 2000
       or btrim(v_meal->>'label') = '' or btrim(v_meal->>'text') = ''
    then return false; end if;
  end loop;
  return true;
end;
$$;

create table public.nutrition_plans (
  athlete_id uuid not null references public.profiles(id) on delete cascade,
  status text not null check (status in ('draft','published')),
  revision integer not null default 1 check (revision > 0),
  plan jsonb not null check (private.valid_nutrition_plan(plan)),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, status)
);

alter table public.nutrition_plans enable row level security;
create policy nutrition_read on public.nutrition_plans for select to authenticated
using (private.coach_owns_athlete((select auth.uid()), athlete_id)
  or (status = 'published' and athlete_id = (select auth.uid()) and private.is_active_athlete((select auth.uid()))));
revoke all on public.nutrition_plans from anon, authenticated;
grant select on public.nutrition_plans to authenticated;

create function public.save_client_nutrition(p_athlete_id uuid, p_expected_revision integer, p_plan jsonb, p_publish boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_draft public.nutrition_plans; v_published public.nutrition_plans;
begin
  if not private.coach_owns_athlete(auth.uid(), p_athlete_id) then
    raise exception using errcode='42501', message='Cliente non autorizzato.';
  end if;
  if not private.valid_nutrition_plan(p_plan) or p_expected_revision is null or p_expected_revision < 0 then
    raise exception using errcode='22023', message='Controlla i dati dei consigli alimentari.';
  end if;
  if p_publish and btrim(p_plan->>'notes') = '' and jsonb_array_length(p_plan->'meals') = 0 then
    raise exception using errcode='22023', message='Aggiungi almeno un consiglio o un pasto.';
  end if;
  if p_expected_revision = 0 then
    insert into public.nutrition_plans(athlete_id, status, plan)
    values (p_athlete_id, 'draft', p_plan) on conflict do nothing returning * into v_draft;
  else
    update public.nutrition_plans set plan = p_plan, revision = revision + 1, updated_at = now()
    where athlete_id = p_athlete_id and status = 'draft' and revision = p_expected_revision returning * into v_draft;
  end if;
  if v_draft.athlete_id is null then
    raise exception using errcode='40001', message='La bozza è stata aggiornata. Ricaricala prima di salvare.';
  end if;
  if p_publish then
    insert into public.nutrition_plans(athlete_id, status, revision, plan)
    values (p_athlete_id, 'published', v_draft.revision, v_draft.plan)
    on conflict (athlete_id, status) do update
      set plan=excluded.plan, revision=excluded.revision, updated_at=now()
    returning * into v_published;
  end if;
  return jsonb_build_object('draftRevision', v_draft.revision, 'publishedRevision', v_published.revision);
end;
$$;

revoke all on function public.save_client_nutrition(uuid, integer, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.save_client_nutrition(uuid, integer, jsonb, boolean) to authenticated;

alter publication supabase_realtime add table public.nutrition_plans;
