-- Re-states close_batch as finished in 20261105000800 (only an on-the-way
-- "join now" seat is spared when a batch is loaded), for local databases that
-- applied an earlier draft of that file. Safe to run again.

create or replace function public.close_batch(p_b public.meal_batches, p_open_next boolean, p_penalize boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
  v_missed integer := 0;
  v_event uuid;
  v_ms public.meal_services;
  v_next public.meal_batches;
begin
  select * into v_ms from public.meal_services where id = p_b.meal_service_id;
  update public.meal_batches set loaded_at = now(), loaded_by = auth.uid() where id = p_b.id;
  for s in
    select * from public.batch_seats where batch_id = p_b.id and state in ('HOLDING', 'RELEASED') for update
  loop
    -- A "join now" student still within their minutes is on the way: no penalty; they are told.
    -- (Booked students knew the start time; loading counts them as missed, as before.)
    if s.state = 'HOLDING' and s.kind = 'JOIN_NOW' and not public.seat_lapsed(s, p_b) then
      update public.batch_seats set state = 'CANCELLED', closed_at = now() where id = s.id;
      if s.user_id is not null and p_penalize then
        perform public.enqueue_notification(s.user_id, 'SEAT_RELEASED', 'seat-closed:' || s.id,
          jsonb_build_object('message', 'Batch ' || p_b.number || ' filled up and closed before you arrived. '
            || 'This does not count as a missed meal; book the next batch.'));
      end if;
      continue;
    end if;
    if not p_penalize or s.user_id is null
       or exists (select 1 from public.attendance_records a
                  where a.meal_service_id = s.meal_service_id and a.coupon_id = s.coupon_id and a.status = 'VALID')
       or exists (select 1 from public.batch_seats o
                  where o.meal_service_id = s.meal_service_id and o.user_id = s.user_id and o.state = 'ARRIVED') then
      update public.batch_seats set state = 'CANCELLED', closed_at = now() where id = s.id;
      continue;
    end if;
    update public.batch_seats set state = 'MISSED', closed_at = now() where id = s.id;
    insert into public.no_show_events (meal_service_id, user_id, coupon_id, coupon_number, commitment, batch_seat_id,
                                       status, verified_at, policy_version)
    values (s.meal_service_id, s.user_id, s.coupon_id, s.coupon_number, 'BOOKING', s.id,
            'VERIFIED', now(), v_ms.policy_version)
    returning id into v_event;
    perform public.write_audit('NO_SHOW_VERIFIED', 'no_show_event', v_event::text, null, null,
                               'Batch ' || p_b.number || ' loaded without them');
    perform public.apply_penalty_for(v_event);
    v_missed := v_missed + 1;
  end loop;
  if p_open_next then
    insert into public.meal_batches (meal_service_id, number, capacity, booking_opens_at)
    values (p_b.meal_service_id, p_b.number + 1, v_ms.batch_capacity, now())
    returning * into v_next;
  end if;
  return jsonb_build_object('batch', p_b.number, 'missed', v_missed,
    'arrived', (select count(*) from public.batch_seats where batch_id = p_b.id and state = 'ARRIVED'),
    'next_batch', v_next.number);
end $$;
