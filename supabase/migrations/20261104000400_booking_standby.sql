-- Phase 3 — booking, the dinner-wide standby queue, cancellation and
-- race-safe seat holds.
--
-- Seat holds (spec §2 I2/I3/I8, §12 "no more capacity-holding reservations
-- than a wave can accommodate"):
--   * Every confirmed seat is a `reservations` row tied to one aisle wave.
--   * A trigger keeps aisle_waves.held_seats equal to the number of
--     seat-holding reservations, and a CHECK keeps held_seats <= capacity.
--     Over-booking is therefore impossible even for a buggy function or a
--     superuser insert, and the counter update row-locks the wave, which
--     serialises concurrent allocations.
--   * A reservation keeps holding its seat until physical evidence frees it:
--     CONFIRMED, CANCELLED_PENDING_VACANCY (cancelled after the gate opened),
--     EXPIRED_PENDING_RECONCILIATION and VERIFIED_DINED all hold.
--
-- Booking policy (spec §4.2): first valid bookings in the window get seats,
-- filling aisle A before B. Everyone else joins one dinner-wide standby
-- queue ordered by (priority_tier, queued_at, random tiebreak). Before the
-- promotion cutoff (default T−5), a freed or newly opened seat is given
-- directly to the head of the queue; after it, seats wait for the
-- snapshot-gated offers of Phase 5. Standby never holds a seat and never
-- authorises entry.
--
-- Lock order used by every function: aisle → meal service → wave →
-- participation → reservation.

-- ---------------------------------------------------------------------------
-- Policy v2: direct-promotion cutoff
-- ---------------------------------------------------------------------------

insert into public.policy_settings (version, settings, is_active, note)
select 2, settings || jsonb_build_object('standby_promotion_cutoff_minutes_before_start', 5),
       false, 'Phase 3: stop direct standby promotion 5 minutes before the gate opens'
from public.policy_settings where version = 1;
update public.policy_settings set is_active = false where version = 1;
update public.policy_settings set is_active = true where version = 2;

-- A policy value as pinned by the meal service, falling back to the active
-- version for keys added after the service was created.
create function public.meal_policy_int(p_meal_service_id uuid, p_key text) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select (ps.settings ->> p_key)::integer
     from public.meal_services ms join public.policy_settings ps on ps.version = ms.policy_version
     where ms.id = p_meal_service_id),
    public.policy_int(p_key))
$$;

-- NOT_OPEN (before T−15, which includes the T−30..T−15 lock), OPEN (T−15..T),
-- STANDBY_ONLY (service running: join the waitlist only), CLOSED.
create function public.booking_window(p_meal_service_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when ms.state not in ('SCHEDULED', 'IN_SERVICE') then 'CLOSED'
    when now() < ms.service_start_at
                 - make_interval(mins => public.meal_policy_int(ms.id, 'booking_open_minutes_before_start'))
      then 'NOT_OPEN'
    when now() < ms.service_start_at then 'OPEN'
    else 'STANDBY_ONLY'
  end
  from public.meal_services ms where ms.id = p_meal_service_id
$$;

create function public.before_promotion_cutoff(p_meal_service_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select now() < ms.service_start_at
               - make_interval(mins => public.meal_policy_int(ms.id, 'standby_promotion_cutoff_minutes_before_start'))
  from public.meal_services ms where ms.id = p_meal_service_id
$$;

-- ---------------------------------------------------------------------------
-- Notification outbox (written in the same transaction as the decision;
-- delivery is a separate, retryable worker — Phase 5/7)
-- ---------------------------------------------------------------------------

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id),
  kind text not null,
  event_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz
);

create index notification_outbox_recipient_idx on public.notification_outbox (recipient_id, created_at desc);
create index notification_outbox_pending_idx on public.notification_outbox (next_attempt_at) where status = 'PENDING';

create function public.enqueue_notification(
  p_recipient uuid, p_kind text, p_event_key text, p_payload jsonb
) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into public.notification_outbox (recipient_id, kind, event_key, payload)
  values (p_recipient, p_kind, p_event_key, coalesce(p_payload, '{}'::jsonb))
  on conflict (event_key) do nothing
$$;

-- ---------------------------------------------------------------------------
-- Participations: one per coupon (and per student) per meal service
-- ---------------------------------------------------------------------------

create type public.participation_status as enum ('STANDBY', 'CONFIRMED', 'CANCELLED');

create table public.booking_participations (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  user_id uuid not null references public.profiles (id),
  coupon_id uuid not null references public.coupons (id),
  coupon_number integer not null,
  status public.participation_status not null,
  -- 0 = normal. Phase 6 may raise it by one for a single wave as the mild
  -- repeat-no-show priority reduction.
  priority_tier smallint not null default 0 check (priority_tier between 0 and 9),
  queued_at timestamptz not null default now(),
  queue_tiebreak double precision not null default random(),
  registered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- I5: a coupon participates once per meal service, across every aisle and wave.
  unique (meal_service_id, coupon_id),
  unique (meal_service_id, user_id)
);

create index booking_participations_queue_idx
  on public.booking_participations (meal_service_id, priority_tier, queued_at, queue_tiebreak)
  where status = 'STANDBY';

create function public.booking_participations_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'participations are never deleted' using errcode = '42501';
  end if;
  if new.meal_service_id <> old.meal_service_id or new.user_id <> old.user_id
     or new.coupon_id <> old.coupon_id or new.coupon_number <> old.coupon_number then
    raise exception 'participation identity columns are immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger booking_participations_guard
  before update or delete on public.booking_participations
  for each row execute function public.booking_participations_guard();

-- ---------------------------------------------------------------------------
-- Reservations: confirmed seat holds
-- ---------------------------------------------------------------------------

create type public.reservation_state as enum (
  'CONFIRMED',                       -- holds; may arrive until arrive_by
  'CANCELLED',                       -- released (cancelled before the gate opened, or vacancy verified)
  'CANCELLED_PENDING_VACANCY',       -- holds; cancelled after the gate opened, until a snapshot frees it
  'EXPIRED_PENDING_RECONCILIATION',  -- holds; deadline passed, presence unknown (Phase 5)
  'RELEASED',                        -- released; verified empty by a snapshot (Phase 5)
  'VERIFIED_DINED',                  -- holds; coupon collected by the attendant (Phase 4)
  'NO_SHOW'                          -- released; absence verified after a finished round (Phase 6)
);
create type public.reservation_source as enum ('INITIAL_BOOKING', 'STANDBY_PROMOTION', 'STANDBY_OFFER');

create function public.reservation_holds_seat(p_state public.reservation_state) returns boolean
language sql immutable as $$
  select p_state in ('CONFIRMED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION', 'VERIFIED_DINED')
$$;

alter table public.aisle_waves
  add column held_seats smallint not null default 0,
  add constraint aisle_waves_holds_within_capacity check (held_seats between 0 and capacity);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  booking_ref text not null unique,          -- e.g. DIN-2026-11-04-A-001; never a coupon number
  participation_id uuid not null references public.booking_participations (id),
  meal_service_id uuid not null references public.meal_services (id),
  wave_id uuid not null references public.aisle_waves (id),
  aisle_code public.aisle_code not null,
  user_id uuid not null references public.profiles (id),
  coupon_id uuid not null references public.coupons (id),
  coupon_number integer not null,            -- original hall coupon, immutable
  state public.reservation_state not null default 'CONFIRMED',
  source public.reservation_source not null,
  arrive_by timestamptz not null,
  policy_version integer not null references public.policy_settings (version),
  created_at timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  state_reason text
);

create unique index reservations_one_hold_per_coupon
  on public.reservations (meal_service_id, coupon_id)
  where state in ('CONFIRMED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION', 'VERIFIED_DINED');
create index reservations_wave_idx on public.reservations (wave_id, state);
create index reservations_participation_idx on public.reservations (participation_id);

create function public.reservations_guard() returns trigger
language plpgsql as $$
declare
  v_wave public.aisle_waves;
  v_part public.booking_participations;
begin
  if tg_op = 'DELETE' then
    raise exception 'reservations are never deleted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select * into v_wave from public.aisle_waves where id = new.wave_id;
    if v_wave.phase = 'CLOSED' then
      raise exception 'cannot hold a seat in a closed wave' using errcode = '23514';
    end if;
    if v_wave.meal_service_id <> new.meal_service_id or v_wave.aisle_code <> new.aisle_code then
      raise exception 'reservation must match its wave''s meal service and aisle' using errcode = '23514';
    end if;
    select * into v_part from public.booking_participations where id = new.participation_id;
    if v_part.meal_service_id <> new.meal_service_id or v_part.user_id <> new.user_id
       or v_part.coupon_id <> new.coupon_id or v_part.coupon_number <> new.coupon_number then
      raise exception 'reservation must match its participation' using errcode = '23514';
    end if;
    return new;
  end if;

  -- I4: a reservation can never move to another student, coupon or wave.
  if new.participation_id <> old.participation_id or new.meal_service_id <> old.meal_service_id
     or new.wave_id <> old.wave_id or new.aisle_code <> old.aisle_code or new.user_id <> old.user_id
     or new.coupon_id <> old.coupon_id or new.coupon_number <> old.coupon_number
     or new.source <> old.source or new.created_at <> old.created_at then
    raise exception 'reservation identity columns are immutable' using errcode = '42501';
  end if;
  if new.state <> old.state then
    new.state_changed_at := now();
  end if;
  return new;
end $$;

create trigger reservations_guard
  before insert or update or delete on public.reservations
  for each row execute function public.reservations_guard();

create function public.reservations_hold_counter() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_delta integer;
begin
  if tg_op = 'INSERT' then
    v_delta := public.reservation_holds_seat(new.state)::integer;
  else
    v_delta := public.reservation_holds_seat(new.state)::integer - public.reservation_holds_seat(old.state)::integer;
  end if;
  if v_delta <> 0 then
    -- Closed waves are frozen history; their counter no longer matters.
    update public.aisle_waves set held_seats = held_seats + v_delta
    where id = new.wave_id and phase <> 'CLOSED';
  end if;
  return null;
end $$;

create trigger reservations_hold_counter
  after insert or update of state on public.reservations
  for each row execute function public.reservations_hold_counter();

-- ---------------------------------------------------------------------------
-- Internal allocation helpers (callers hold the meal service row lock)
-- ---------------------------------------------------------------------------

create function public.create_reservation_locked(
  p_participation_id uuid, p_wave_id uuid, p_source public.reservation_source
) returns public.reservations
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_part public.booking_participations;
  v_wave public.aisle_waves;
  v_service public.meal_services;
  v_seq integer;
  v_res public.reservations;
begin
  select * into v_part from public.booking_participations where id = p_participation_id for update;
  select * into v_wave from public.aisle_waves where id = p_wave_id;
  select * into v_service from public.meal_services where id = v_part.meal_service_id;

  select count(*) + 1 into v_seq from public.reservations
  where meal_service_id = v_service.id and aisle_code = v_wave.aisle_code;

  insert into public.reservations (
    booking_ref, participation_id, meal_service_id, wave_id, aisle_code,
    user_id, coupon_id, coupon_number, source, arrive_by, policy_version
  )
  values (
    format('%s-%s-%s-%s',
      case v_service.meal_type when 'BREAKFAST' then 'BRK' when 'LUNCH' then 'LUN' else 'DIN' end,
      to_char(v_service.service_date, 'YYYY-MM-DD'), v_wave.aisle_code, lpad(v_seq::text, 3, '0')),
    v_part.id, v_service.id, v_wave.id, v_wave.aisle_code,
    v_part.user_id, v_part.coupon_id, v_part.coupon_number, p_source,
    v_service.service_start_at
      + make_interval(mins => public.meal_policy_int(v_service.id, 'confirmed_arrival_window_minutes')),
    v_service.policy_version
  )
  returning * into v_res;

  update public.booking_participations set status = 'CONFIRMED' where id = v_part.id;

  perform public.enqueue_notification(
    v_part.user_id,
    case when p_source = 'INITIAL_BOOKING' then 'BOOKING_CONFIRMED' else 'PROMOTED_FROM_STANDBY' end,
    'reservation-confirmed:' || v_res.id,
    jsonb_build_object('booking_ref', v_res.booking_ref, 'aisle', v_res.aisle_code,
                       'arrive_by', v_res.arrive_by, 'coupon_number', v_res.coupon_number));

  perform public.write_audit('RESERVATION_CONFIRMED', 'reservation', v_res.id::text, null, to_jsonb(v_res));
  return v_res;
end $$;

-- The open BOOKING-phase wave with a free seat, aisle A first; locked.
create function public.free_booking_wave_locked(p_meal_service_id uuid) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select id from public.aisle_waves
  where meal_service_id = p_meal_service_id and phase = 'BOOKING' and held_seats < capacity
  order by aisle_code
  limit 1
  for update
$$;

-- Head of the standby queue whose holder still owns the coupon; locked.
create function public.next_standby_locked(p_meal_service_id uuid) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select bp.id from public.booking_participations bp
  where bp.meal_service_id = p_meal_service_id and bp.status = 'STANDBY'
    and exists (select 1 from public.coupon_claims c
                where c.user_id = bp.user_id and c.coupon_id = bp.coupon_id and c.status = 'APPROVED')
  order by bp.priority_tier, bp.queued_at, bp.queue_tiebreak
  limit 1
  for update of bp
$$;

-- Before the promotion cutoff, move the head of the queue into free seats.
-- Returns the number of students promoted.
create function public.fill_from_standby_locked(p_meal_service_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_wave_id uuid;
  v_part_id uuid;
  v_count integer := 0;
begin
  if public.booking_window(p_meal_service_id) <> 'OPEN' or not public.before_promotion_cutoff(p_meal_service_id) then
    return 0;
  end if;
  loop
    v_wave_id := public.free_booking_wave_locked(p_meal_service_id);
    exit when v_wave_id is null;
    v_part_id := public.next_standby_locked(p_meal_service_id);
    exit when v_part_id is null;
    perform public.create_reservation_locked(v_part_id, v_wave_id, 'STANDBY_PROMOTION');
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- The caller-facing view of one participation.
create function public.participation_status_json(p_participation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_part public.booking_participations;
  v_res public.reservations;
  v_ahead integer;
begin
  select * into v_part from public.booking_participations where id = p_participation_id;
  if v_part.status = 'STANDBY' then
    select count(*) into v_ahead from public.booking_participations o
    where o.meal_service_id = v_part.meal_service_id and o.status = 'STANDBY'
      and (o.priority_tier, o.queued_at, o.queue_tiebreak) < (v_part.priority_tier, v_part.queued_at, v_part.queue_tiebreak);
    return jsonb_build_object(
      'participation', 'STANDBY',
      'coupon_number', v_part.coupon_number,
      'standby_band', case when v_ahead < 5 then '1-5' when v_ahead < 10 then '6-10'
                           when v_ahead < 20 then '11-20' else '21+' end,
      'message', 'You are on standby. Do not come unless you receive an individual invitation.');
  end if;

  select * into v_res from public.reservations
  where participation_id = v_part.id order by created_at desc limit 1;
  return jsonb_build_object(
    'participation', v_part.status,
    'coupon_number', v_part.coupon_number,
    'reservation_state', v_res.state,
    'booking_ref', v_res.booking_ref,
    'aisle', v_res.aisle_code,
    'arrive_by', v_res.arrive_by);
end $$;

-- ---------------------------------------------------------------------------
-- Student API
-- ---------------------------------------------------------------------------

create function public.book_meal(p_meal_service_id uuid, p_idempotency_key text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_action text := 'book_meal:' || p_meal_service_id;
  v_prior jsonb;
  v_coupon_id uuid;
  v_coupon_number integer;
  v_window text;
  v_part public.booking_participations;
  v_wave_id uuid;
  v_result jsonb;
begin
  v_prior := public.idem_lookup(p_idempotency_key, v_action);
  if v_prior is not null then
    return v_prior;
  end if;

  v_coupon_id := public.verified_coupon_id(v_uid);
  if v_coupon_id is null then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  select coupon_number into v_coupon_number from public.coupons where id = v_coupon_id;

  perform 1 from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;

  -- One entitlement per coupon per meal service, whoever holds it now.
  select * into v_part from public.booking_participations
  where meal_service_id = p_meal_service_id and (coupon_id = v_coupon_id or user_id = v_uid)
  for update;
  if v_part.id is not null and (v_part.user_id <> v_uid or v_part.coupon_id <> v_coupon_id) then
    perform public.raise_admin_alert(
      'IDENTITY_CONFLICT', 'booking-conflict:' || p_meal_service_id || ':' || v_coupon_id || ':' || v_uid,
      jsonb_build_object('meal_service_id', p_meal_service_id, 'coupon_number', v_coupon_number,
                         'requesting_user_id', v_uid, 'existing_user_id', v_part.user_id));
    return jsonb_build_object('status', 'COUPON_CONFLICT');
  end if;
  if v_part.id is not null and v_part.status <> 'CANCELLED' then
    return jsonb_build_object('status', 'ALREADY_REGISTERED') || public.participation_status_json(v_part.id);
  end if;

  v_window := public.booking_window(p_meal_service_id);
  if v_window in ('NOT_OPEN', 'CLOSED') then
    return jsonb_build_object('status', 'BOOKING_' || v_window);
  end if;

  if v_part.id is not null then
    -- Cancelled earlier: rejoin at the back of the queue.
    update public.booking_participations
    set status = 'STANDBY', queued_at = now(), queue_tiebreak = random()
    where id = v_part.id
    returning * into v_part;
  else
    insert into public.booking_participations (meal_service_id, user_id, coupon_id, coupon_number, status)
    values (p_meal_service_id, v_uid, v_coupon_id, v_coupon_number, 'STANDBY')
    returning * into v_part;
  end if;

  if v_window = 'OPEN' then
    -- A free seat goes to the newcomer only if nobody is queued ahead of
    -- them, so registering never jumps people already waiting.
    if public.next_standby_locked(p_meal_service_id) = v_part.id then
      v_wave_id := public.free_booking_wave_locked(p_meal_service_id);
      if v_wave_id is not null then
        perform public.create_reservation_locked(v_part.id, v_wave_id, 'INITIAL_BOOKING');
      end if;
    end if;
    -- Anyone still queued with seats free (before the cutoff) is promoted in order.
    perform public.fill_from_standby_locked(p_meal_service_id);
    select * into v_part from public.booking_participations where id = v_part.id;
  end if;

  if v_part.status = 'STANDBY' then
    perform public.enqueue_notification(v_uid, 'STANDBY_REGISTERED',
      'standby:' || v_part.id || ':' || v_part.queued_at,
      jsonb_build_object('message', 'You are on standby. Do not come unless you receive an individual invitation.'));
  end if;

  perform public.write_audit('MEAL_BOOKED', 'booking_participation', v_part.id::text, null,
    jsonb_build_object('status', v_part.status, 'window', v_window, 'coupon_number', v_coupon_number));

  v_result := jsonb_build_object('status', v_part.status) || public.participation_status_json(v_part.id);
  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

create function public.cancel_booking(p_meal_service_id uuid, p_idempotency_key text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_action text := 'cancel_booking:' || p_meal_service_id;
  v_prior jsonb;
  v_service public.meal_services;
  v_part public.booking_participations;
  v_res public.reservations;
  v_wave public.aisle_waves;
  v_promoted integer := 0;
  v_result jsonb;
begin
  v_prior := public.idem_lookup(p_idempotency_key, v_action);
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_service from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;

  select * into v_part from public.booking_participations
  where meal_service_id = p_meal_service_id and user_id = v_uid;
  if not found then
    return jsonb_build_object('status', 'NOT_REGISTERED');
  end if;
  if v_part.status = 'CANCELLED' then
    return jsonb_build_object('status', 'ALREADY_CANCELLED');
  end if;

  if v_part.status = 'STANDBY' then
    update public.booking_participations set status = 'CANCELLED' where id = v_part.id;
    perform public.write_audit('STANDBY_LEFT', 'booking_participation', v_part.id::text,
      jsonb_build_object('status', 'STANDBY'), jsonb_build_object('status', 'CANCELLED'));
    return public.idem_store(p_idempotency_key, v_action, jsonb_build_object('status', 'LEFT_STANDBY'));
  end if;

  select * into v_res from public.reservations
  where participation_id = v_part.id and public.reservation_holds_seat(state);
  if v_res.id is null then
    raise exception 'confirmed participation % has no seat hold', v_part.id using errcode = 'XX000';
  end if;
  select * into v_wave from public.aisle_waves where id = v_res.wave_id for update;
  select * into v_part from public.booking_participations where id = v_part.id for update;
  select * into v_res from public.reservations where id = v_res.id for update;

  if v_res.state = 'VERIFIED_DINED' then
    return jsonb_build_object('status', 'CANNOT_CANCEL_AFTER_DINING');
  end if;
  if v_res.state <> 'CONFIRMED' then
    return jsonb_build_object('status', 'NOT_CANCELLABLE', 'reservation_state', v_res.state);
  end if;

  update public.booking_participations set status = 'CANCELLED' where id = v_part.id;

  if now() < v_service.service_start_at and v_wave.phase = 'BOOKING' then
    -- Nobody can be inside yet: the seat is genuinely free.
    update public.reservations set state = 'CANCELLED', state_reason = 'Cancelled by student before gate opened'
    where id = v_res.id;
    v_promoted := public.fill_from_standby_locked(p_meal_service_id);
    v_result := jsonb_build_object('status', 'CANCELLED', 'seat_released', true, 'promoted', v_promoted);
  else
    -- The gate is open: they might already be seated. Keep holding the seat
    -- until a physical snapshot shows the vacancy (Phase 5).
    update public.reservations
    set state = 'CANCELLED_PENDING_VACANCY', state_reason = 'Cancelled by student after gate opened'
    where id = v_res.id;
    v_result := jsonb_build_object('status', 'CANCELLED', 'seat_released', false, 'promoted', 0);
  end if;

  perform public.write_audit('RESERVATION_CANCELLED', 'reservation', v_res.id::text,
    jsonb_build_object('state', v_res.state), v_result);
  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

create function public.my_booking_status(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_part_id uuid;
begin
  select id into v_part_id from public.booking_participations
  where meal_service_id = p_meal_service_id and user_id = v_uid;
  if v_part_id is null then
    return jsonb_build_object('status', 'NOT_REGISTERED', 'window', public.booking_window(p_meal_service_id));
  end if;
  return jsonb_build_object('status', 'OK', 'window', public.booking_window(p_meal_service_id))
         || public.participation_status_json(v_part_id);
end $$;

-- Aggregate numbers only; safe for any signed-in user.
create function public.meal_service_summary(p_meal_service_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'window', public.booking_window(p_meal_service_id),
    'live_wave_capacity', coalesce((select sum(capacity) from public.aisle_waves
                                    where meal_service_id = p_meal_service_id and phase <> 'CLOSED'), 0),
    'held_seats', coalesce((select sum(held_seats) from public.aisle_waves
                            where meal_service_id = p_meal_service_id and phase <> 'CLOSED'), 0),
    'standby', (select count(*) from public.booking_participations
                where meal_service_id = p_meal_service_id and status = 'STANDBY'))
$$;

-- ---------------------------------------------------------------------------
-- Phase 2 operations, now aware of seat holds
-- ---------------------------------------------------------------------------

create or replace function public.open_aisle_wave_locked(
  p_aisle public.aisle_code, p_meal_service_id uuid, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_aisle public.aisles;
  v_service public.meal_services;
  v_wave public.aisle_waves;
  v_capacity smallint;
  v_promoted integer;
begin
  select * into v_aisle from public.aisles where code = p_aisle for update;
  if v_aisle.readiness <> 'READY' then
    return jsonb_build_object('status', 'AISLE_NOT_READY', 'readiness', v_aisle.readiness,
                              'wave_id', v_aisle.current_wave_id);
  end if;

  select * into v_service from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;
  if v_service.state not in ('SCHEDULED', 'IN_SERVICE') then
    return jsonb_build_object('status', 'MEAL_SERVICE_NOT_OPEN', 'state', v_service.state);
  end if;

  v_capacity := v_aisle.physical_capacity - v_aisle.unusable_seats;
  if v_capacity < 1 then
    return jsonb_build_object('status', 'NO_USABLE_SEATS');
  end if;

  insert into public.aisle_waves (
    meal_service_id, aisle_code, wave_number, capacity,
    ready_confirmed_by, ready_confirmed_at, opened_by
  )
  values (
    p_meal_service_id, p_aisle,
    coalesce((select max(wave_number) from public.aisle_waves
              where meal_service_id = p_meal_service_id and aisle_code = p_aisle), 0) + 1,
    v_capacity, v_aisle.ready_confirmed_by, v_aisle.ready_confirmed_at, p_actor
  )
  returning * into v_wave;

  update public.aisles set readiness = 'IN_WAVE', current_wave_id = v_wave.id where code = p_aisle;

  perform public.write_audit('AISLE_WAVE_OPENED', 'aisle_wave', v_wave.id::text,
    jsonb_build_object('aisle_readiness', v_aisle.readiness), to_jsonb(v_wave));

  -- An aisle readied during the booking window takes people already queued.
  v_promoted := public.fill_from_standby_locked(p_meal_service_id);

  return jsonb_build_object('status', 'WAVE_OPENED', 'wave_id', v_wave.id,
                            'wave_number', v_wave.wave_number, 'capacity', v_wave.capacity,
                            'promoted_from_standby', v_promoted);
end $$;

create or replace function public.close_aisle_wave(
  p_wave_id uuid, p_confirm_all_diners_left boolean, p_note text default null,
  p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_action text := 'close_aisle_wave:' || p_wave_id;
  v_prior jsonb;
  v_wave public.aisle_waves;
  v_expired integer;
  v_result jsonb;
begin
  v_prior := public.idem_lookup(p_idempotency_key, v_action);
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_wave from public.aisle_waves where id = p_wave_id;
  if not found then
    raise exception 'wave not found' using errcode = 'P0002';
  end if;
  perform 1 from public.aisles where code = v_wave.aisle_code for update;
  perform 1 from public.meal_services where id = v_wave.meal_service_id for update;
  select * into v_wave from public.aisle_waves where id = p_wave_id for update;

  if v_wave.phase = 'CLOSED' then
    return jsonb_build_object('status', 'ALREADY_CLOSED');
  end if;
  if not coalesce(p_confirm_all_diners_left, false) then
    return jsonb_build_object('status', 'ATTESTATION_REQUIRED');
  end if;

  -- The aisle is physically empty now. Confirmed bookings never collected
  -- are not no-shows yet: they wait for reconciliation (spec I9). A
  -- cancellation that was waiting for proof of vacancy now has it.
  update public.reservations
  set state = 'EXPIRED_PENDING_RECONCILIATION', state_reason = 'Wave closed without coupon record'
  where wave_id = p_wave_id and state = 'CONFIRMED';
  get diagnostics v_expired = row_count;
  update public.reservations
  set state = 'CANCELLED', state_reason = 'Aisle confirmed empty'
  where wave_id = p_wave_id and state = 'CANCELLED_PENDING_VACANCY';

  update public.aisles set readiness = 'RESTORING', current_wave_id = null
  where code = v_wave.aisle_code and current_wave_id = p_wave_id;

  update public.aisle_waves
  set phase = 'CLOSED', closed_at = now(), closed_by = v_uid, close_note = p_note
  where id = p_wave_id;

  perform public.write_audit('AISLE_WAVE_CLOSED', 'aisle_wave', p_wave_id::text,
    jsonb_build_object('phase', v_wave.phase, 'held_seats', v_wave.held_seats),
    jsonb_build_object('phase', 'CLOSED', 'all_diners_left', true, 'pending_reconciliation', v_expired), p_note);

  v_result := jsonb_build_object('status', 'CLOSED', 'aisle_readiness', 'RESTORING',
                                 'pending_reconciliation', v_expired);
  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

create or replace function public.set_aisle_unusable_seats(
  p_aisle public.aisle_code, p_unusable_seats smallint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_aisle public.aisles;
  v_wave public.aisle_waves;
  v_new_usable smallint;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_aisle from public.aisles where code = p_aisle for update;
  if p_unusable_seats = v_aisle.unusable_seats then
    return jsonb_build_object('status', 'UNCHANGED');
  end if;
  v_new_usable := v_aisle.physical_capacity - p_unusable_seats;

  if v_aisle.current_wave_id is not null then
    select * into v_wave from public.aisle_waves where id = v_aisle.current_wave_id for update;
    if v_new_usable < v_wave.held_seats then
      -- Students already hold these seats; an admin must resolve that first.
      return jsonb_build_object('status', 'HOLDS_EXCEED_CAPACITY', 'held_seats', v_wave.held_seats);
    end if;
    if v_new_usable < v_wave.capacity then
      update public.aisle_waves set capacity = v_new_usable where id = v_wave.id;
    end if;
  end if;

  update public.aisles set unusable_seats = p_unusable_seats where code = p_aisle;

  perform public.write_audit('AISLE_UNUSABLE_SEATS_CHANGED', 'aisle', p_aisle::text,
    jsonb_build_object('unusable_seats', v_aisle.unusable_seats, 'wave_capacity', v_wave.capacity),
    jsonb_build_object('unusable_seats', p_unusable_seats,
                       'wave_capacity', least(v_wave.capacity, v_new_usable)),
    p_reason);
  return jsonb_build_object('status', 'OK', 'usable_capacity', v_new_usable,
                            'wave_capacity', least(v_wave.capacity, v_new_usable));
end $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.booking_participations enable row level security;
alter table public.reservations enable row level security;
alter table public.notification_outbox enable row level security;

-- Attendants need current bookings for their job (spec §14).
create policy booking_participations_select on public.booking_participations for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ATTENDANT');
create policy reservations_select on public.reservations for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ATTENDANT');
create policy notification_outbox_select on public.notification_outbox for select to authenticated
  using (recipient_id = auth.uid());

grant select on public.booking_participations, public.reservations, public.notification_outbox to authenticated;

grant execute on function
  public.book_meal(uuid, text),
  public.cancel_booking(uuid, text),
  public.my_booking_status(uuid),
  public.meal_service_summary(uuid)
to authenticated;
