-- Load fix after the 2026-11-07 freeze: every open booking screen asked the database for the
-- whole booking state every 3 seconds, so a few hundred phones meant 100+ calls a second.
--
-- meal_live_state is the part of that state that is the same for everyone: the open batch
-- (seats taken, phase, times), the batch filled last and the next-start estimate. Phones read
-- it through /api/meal-live, which keeps each answer for a second or two, so all the open
-- screens together cost the database about one call every couple of seconds. Each phone still
-- asks for its own seat (meal_seating), but only now and then (see components/meal-booking.tsx).
--
-- It holds nothing personal and is called only by the server (service role), never by clients.

create function public.meal_live_state(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  v_b public.meal_batches;
  v_prev public.meal_batches;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    return null;
  end if;
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null;
  select * into v_prev from public.meal_batches where meal_service_id = v_ms.id and loaded_at is not null
  order by number desc limit 1;
  return jsonb_build_object(
    'meal_state', v_ms.state,
    'batch', public.batch_json(v_b),
    'previous', public.last_filled_json(v_ms.id),
    'estimate_next_start', case when v_b.id is not null and v_b.starts_at is null and v_prev.id is not null
      then v_prev.loaded_at + make_interval(mins => public.typical_turnover_minutes()) end,
    'as_of', now());
end $$;

revoke all on function public.meal_live_state(uuid) from public;
grant execute on function public.meal_live_state(uuid) to service_role;

-- meal_seating also says when it was read, so a phone can ignore a cached shared answer that is
-- older than its own (otherwise the seat bar can step back by one right after the student books).
create or replace function public.meal_seating(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
  v_b public.meal_batches;
  v_prev public.meal_batches;
  v_seat public.batch_seats;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  select * into v_b from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null;
  select * into v_prev from public.meal_batches where meal_service_id = v_ms.id and loaded_at is not null
  order by number desc limit 1;
  select * into v_seat from public.batch_seats where meal_service_id = v_ms.id and user_id = v_uid
  order by (state in ('HOLDING', 'ARRIVED')) desc, booked_at desc limit 1;
  return jsonb_build_object(
    'meal_state', v_ms.state,
    'batch', public.batch_json(v_b),
    'previous', public.last_filled_json(v_ms.id),
    'estimate_next_start', case when v_b.id is not null and v_b.starts_at is null and v_prev.id is not null
      then v_prev.loaded_at + make_interval(mins => public.typical_turnover_minutes()) end,
    'mine', public.seat_json(v_seat),
    'ate', exists (select 1 from public.attendance_records a
                   where a.meal_service_id = v_ms.id and a.holder_user_id = v_uid and a.status = 'VALID'),
    'said_not_coming', exists (select 1 from public.meal_rsvps r
                               where r.meal_service_id = v_ms.id and r.user_id = v_uid and r.status = 'NOT_COMING'),
    'as_of', now());
end $$;
