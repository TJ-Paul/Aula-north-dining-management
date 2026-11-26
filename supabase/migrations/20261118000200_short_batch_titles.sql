-- Shorter batch notifications (2026-11-18): the meal's name is left out of the batch steps.
--   "Biriyani night: gate open"     -> "Gate open"
--   "Biriyani night: booking open"  -> "Booking open"
--   "Biriyani night: batch 2 full"  -> "Batch 2 full"
-- Only the titles change; who is told, when, and the message line stay as in 20261113000400.

create or replace function public.batch_full_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b public.meal_batches;
  v_ms public.meal_services;
begin
  select * into v_b from public.meal_batches where id = new.batch_id;
  if v_b.full_notified_at is null and v_b.loaded_at is null and new.kind <> 'WALK_IN'
     and public.batch_taken(v_b) >= v_b.capacity then
    update public.meal_batches set full_notified_at = now() where id = v_b.id;
    select * into v_ms from public.meal_services where id = v_b.meal_service_id;
    if public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
      perform public.notify_everyone_titled('BATCH_FULL', 'batch-full:' || v_b.id,
        'Batch ' || v_b.number || ' full',
        'Batch ' || (v_b.number + 1) || ' booking opens next.', v_ms.id);
    end if;
  end if;
  return null;
end $$;

create or replace function public.run_batch_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.meal_batches;
  v_ms public.meal_services;
  v_started integer := 0;
  v_released integer := 0;
begin
  for b in
    select * from public.meal_batches
    where loaded_at is null and starts_at is not null and starts_at <= now() and start_notified_at is null
    for update skip locked
  loop
    perform public.batch_start_notices(b);
    v_started := v_started + 1;
  end loop;

  -- "Booking open" for each batch of a special meal once its booking opens.
  for b in
    select mb.* from public.meal_batches mb join public.meal_services ms on ms.id = mb.meal_service_id
    where mb.booking_notified_at is null and mb.loaded_at is null and mb.booking_opens_at <= now()
      and mb.booking_opens_at > now() - interval '30 minutes' and ms.state in ('SCHEDULED', 'IN_SERVICE')
    for update of mb skip locked
  loop
    select * into v_ms from public.meal_services where id = b.meal_service_id;
    if public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
      perform public.notify_everyone_titled('BOOKING_OPEN', 'booking-open:' || b.id,
        '🎟️ Booking open',
        'Batch ' || b.number || ' · ' || b.capacity || ' seats', v_ms.id);
    end if;
    update public.meal_batches set booking_notified_at = now() where id = b.id;
  end loop;
  return jsonb_build_object('batches_started', v_started, 'seats_released', v_released);
end $$;

-- Gate open: a seat holder gets their own short notice; everyone else the general one (special meals only).
create or replace function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_b.meal_service_id;
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      case when s.kind = 'LUCKY'
        then jsonb_build_object('title', '🚪 Gate open: wait outside',
               'message', 'Batch ' || p_b.number || ' · coupon ' || s.coupon_number || ' · you go in after the booked', 'url', '/')
        else jsonb_build_object('title', '🚪 Gate open: come now',
               'message', 'Batch ' || p_b.number || ' · coupon ' || s.coupon_number, 'url', '/') end);
  end loop;
  if public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
    insert into public.notification_outbox (recipient_id, kind, event_key, payload)
    select p.id, 'GATE_OPEN', 'gate-open:' || p_b.id || ':' || p.id,
           jsonb_build_object('title', '🚪 Gate open',
                              'message', 'Batch ' || p_b.number || '. Booked students, come now.', 'url', '/', 'meal', v_ms.id)
    from public.profiles p
    where p.deleted_at is null and p.role::text <> 'VIEWER'
      and not exists (select 1 from public.batch_seats bs
                      where bs.batch_id = p_b.id and bs.user_id = p.id and bs.state = 'HOLDING')
    on conflict (event_key) do nothing;
  end if;
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;
