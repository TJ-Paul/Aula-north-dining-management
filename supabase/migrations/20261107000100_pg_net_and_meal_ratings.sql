-- 1. Push notifications live: the database wakes the sender through pg_net, which was not
--    switched on in the project. (Skipped where pg_net isn't available, e.g. the local copy.)
-- 2. Ratings are for the food, not the managers: students rate an improvement, feast or paron
--    1–5 stars whenever they like and can change it any time. Manager ratings are no longer shown.

do $net$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $net$;

create table public.meal_ratings (
  meal_service_id uuid not null references public.meal_services (id),
  user_id uuid not null references public.profiles (id),
  stars integer not null check (stars between 1 and 5),
  rated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (meal_service_id, user_id)
);
alter table public.meal_ratings enable row level security;

create function public.rate_meal(p_meal_service_id uuid, p_stars integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if not public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
    return jsonb_build_object('status', 'NOT_RATEABLE');
  end if;
  if v_ms.state = 'CANCELLED' then
    return jsonb_build_object('status', 'MEAL_CANCELLED');
  end if;
  if p_stars is null then
    delete from public.meal_ratings where meal_service_id = v_ms.id and user_id = v_uid;
  elsif p_stars not between 1 and 5 then
    return jsonb_build_object('status', 'INVALID_STARS');
  else
    insert into public.meal_ratings (meal_service_id, user_id, stars) values (v_ms.id, v_uid, p_stars)
    on conflict (meal_service_id, user_id) do update set stars = excluded.stars, updated_at = now();
  end if;
  return jsonb_build_object('status', 'OK') || public.meal_rating_summary(v_ms.id, v_uid);
end $$;

create function public.meal_rating_summary(p_meal_service_id uuid, p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'average', (select round(avg(stars)::numeric, 1) from public.meal_ratings where meal_service_id = p_meal_service_id),
    'count', (select count(*) from public.meal_ratings where meal_service_id = p_meal_service_id),
    'mine', (select stars from public.meal_ratings where meal_service_id = p_meal_service_id and user_id = p_user_id),
    'breakdown', (select coalesce(jsonb_object_agg(stars, n), '{}'::jsonb)
                  from (select stars, count(*) n from public.meal_ratings where meal_service_id = p_meal_service_id group by stars) x))
$$;

create function public.meal_rating_info(p_meal_service_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select public.meal_rating_summary(p_meal_service_id, u.id) from (select public.require_role('VIEWER') as id) u
$$;

grant execute on function public.rate_meal(uuid, integer), public.meal_rating_info(uuid) to authenticated;
