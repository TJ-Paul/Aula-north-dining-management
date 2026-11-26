-- The Everyone tab shows each person's profile photo next to their name.

create or replace function public.person_stats(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when p.id is null then jsonb_build_object('user_id', null) else jsonb_build_object(
    'user_id', p.id, 'public_id', p.public_id, 'name', p.full_name, 'avatar_url', p.avatar_url, 'student_id', p.student_id, 'room', p.room,
    'phone', p.notify_phone, 'role', p.role, 'joined_at', p.created_at,
    'meals_eaten', (select count(*) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'last_meal_at', (select max(a.recorded_at) from public.attendance_records a where a.holder_user_id = p.id and a.status = 'VALID'),
    'missed', (select count(*) from public.no_show_events e where e.user_id = p.id and e.status = 'VERIFIED'),
    'not_coming_kept', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'REWARDED'),
    'came_anyway', (select count(*) from public.meal_rsvps r where r.user_id = p.id and r.outcome = 'CAME_ANYWAY'),
    'points', public.points_balance(p.id)) end
  from (select 1) one left join public.profiles p on p.id = p_user_id
$$;
