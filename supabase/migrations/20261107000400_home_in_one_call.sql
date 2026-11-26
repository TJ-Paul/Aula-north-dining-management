-- The student home screen in two calls instead of six or more (for 450 phones opening the app in
-- the same second):
--
-- - meals_board(): the meals shown on the home screen (in service now, or coming in the next two
--   days) with their menus. The same for everyone, so phones read it through /api/meals-live, which
--   keeps it for a few seconds and lets Vercel's CDN answer most phones. Server (service role) only.
-- - my_home(): everything personal on that screen in one call: profile, "not coming" state for
--   the coming meals, the booking card of each special meal, and the 3-missed mark.
-- Notifications, points, nominations and ratings load a few seconds later, at a random moment.

create function public.home_meal_shown(p_ms public.meal_services) returns boolean
language sql stable as $$
  select (p_ms.state = 'IN_SERVICE' and p_ms.service_start_at between now() - interval '18 hours' and now() + interval '18 hours')
      or (p_ms.state = 'SCHEDULED' and p_ms.service_start_at > now() and p_ms.service_start_at < now() + interval '2 days')
$$;

create function public.meals_board() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'meals', coalesce((select jsonb_agg(public.meal_brief(m) order by m.service_start_at)
                       from public.meal_services m where public.home_meal_shown(m)), '[]'::jsonb),
    'as_of', now())
$$;

create function public.my_home() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
begin
  return jsonb_build_object(
    'profile', public.my_profile(),
    'rsvps', coalesce((select jsonb_object_agg(m.id, public.my_rsvp_json(m, v_uid))
                       from public.meal_services m
                       where m.state = 'SCHEDULED' and public.home_meal_shown(m)), '{}'::jsonb),
    'seating', coalesce((select jsonb_object_agg(m.id, public.meal_seating(m.id))
                         from public.meal_services m
                         where public.home_meal_shown(m) and public.meal_is_special(m.meal_type, m.occasion)), '{}'::jsonb),
    'missed', jsonb_build_object('count', public.no_show_count(v_uid, now()),
                                 'window_days', public.policy_int('penalty_window_days'),
                                 'marked', public.missed_marked(v_uid)));
end $$;

revoke all on function public.home_meal_shown(public.meal_services), public.meals_board(), public.my_home() from public;
grant execute on function public.meals_board() to service_role;
grant execute on function public.my_home() to authenticated;
