-- Phase 5 — automated admissions: snapshot-gated standby invitations.
--
-- After a wave's confirmed arrival deadline, free seats are worked out ONLY
-- from a fresh physical headcount taken after that deadline (spec §3, I6, I7):
--
--   V = max(0, C − O − R)
--     C  wave capacity
--     O  latest headcount (must be newer than the deadline and not stale)
--     R  seats still promised by invitations: offered, accepted, cancelled or
--        expired-but-unverified ones, plus invitees and released bookers whose
--        coupon was collected after the headcount (they are not inside O)
--
-- Exactly V individual offers go to the head of the standby queue. An
-- unanswered or declined offer frees its place at once (nobody could have
-- entered on it); an accepted one that runs out keeps holding until a newer
-- headcount shows the seat is empty (spec §6.3, Case 8). Nothing here ever
-- penalises anyone: that is Phase 6, after the coupon round is finished.
--
-- run_due_jobs() is the single scheduled entry point (pg_cron in Supabase, a
-- timer in local demo mode). Every step is a state transition guarded by its
-- WHERE clause, so running it twice changes nothing the second time.

alter type public.participation_status add value if not exists 'OFFERED';   -- has a live offer
alter type public.participation_status add value if not exists 'INVITED';   -- accepted an offer

create type public.offer_state as enum (
  'OFFERED',                         -- holds; waiting for the student's answer
  'ACCEPTED',                        -- holds; has an entry window
  'DECLINED',                        -- released
  'EXPIRED_UNACKNOWLEDGED',          -- released; never answered (never a penalty)
  'CANCELLED',                       -- released
  'CANCELLED_PENDING_VACANCY',       -- holds; cancelled after accepting, until a headcount
  'EXPIRED_PENDING_RECONCILIATION',  -- holds; entry window passed without a coupon record
  'RELEASED',                        -- released by a newer headcount; identity outcome pending
  'VERIFIED_DINED',                  -- coupon collected
  'VERIFIED_NO_SHOW'                 -- Phase 6
);

create function public.offer_holds_seat(p_state public.offer_state) returns boolean
language sql immutable as $$
  select p_state in ('OFFERED', 'ACCEPTED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION')
$$;

create table public.standby_offers (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  wave_id uuid not null references public.aisle_waves (id),
  aisle_code public.aisle_code not null,
  participation_id uuid not null references public.booking_participations (id),
  user_id uuid not null references public.profiles (id),
  coupon_id uuid not null references public.coupons (id),
  coupon_number integer not null,
  state public.offer_state not null default 'OFFERED',
  based_on_snapshot_id uuid not null references public.occupancy_snapshots (id),
  offered_at timestamptz not null default now(),
  respond_by timestamptz not null,
  accepted_at timestamptz,
  entry_window_start timestamptz,
  entry_window_end timestamptz,
  dined_at timestamptz,
  state_changed_at timestamptz not null default now(),
  state_reason text,
  constraint standby_offers_accepted_shape check (
    state <> 'ACCEPTED' or (accepted_at is not null and entry_window_start is not null and entry_window_end is not null))
);

create unique index standby_offers_one_live_per_coupon
  on public.standby_offers (meal_service_id, coupon_id)
  where state in ('OFFERED', 'ACCEPTED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION', 'VERIFIED_DINED');
create index standby_offers_wave_idx on public.standby_offers (wave_id, state);
create index standby_offers_participation_idx on public.standby_offers (participation_id);
create index standby_offers_due_idx on public.standby_offers (meal_service_id, state, respond_by);

alter table public.attendance_records
  add column offer_id uuid references public.standby_offers (id),
  add column offer_prior_state public.offer_state;

-- ---------------------------------------------------------------------------
-- Vacancy
-- ---------------------------------------------------------------------------

create function public.wave_vacancy(p_wave_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  w public.aisle_waves;
  ms public.meal_services;
  s public.occupancy_snapshots;
  v_has_res boolean;
  v_release timestamptz;
  v_close timestamptz;
  v_out integer;
  v_none jsonb := jsonb_build_object('vacancy', 0);
begin
  select * into w from public.aisle_waves where id = p_wave_id;
  select * into ms from public.meal_services where id = w.meal_service_id;

  if w.phase <> 'ADMITTING' then
    return v_none || jsonb_build_object('status', 'NOT_ADMITTING');
  end if;
  if ms.state <> 'IN_SERVICE' then
    return v_none || jsonb_build_object('status', 'SERVICE_NOT_RUNNING');
  end if;
  if ms.invitations_paused then
    return v_none || jsonb_build_object('status', 'PAUSED');
  end if;

  select count(*) > 0, max(arrive_by) into v_has_res, v_release
  from public.reservations where wave_id = w.id;
  v_release := coalesce(v_release, w.admitting_at, w.opened_at);
  if now() < v_release or exists (select 1 from public.reservations where wave_id = w.id and state = 'CONFIRMED') then
    -- Confirmed students may still arrive: their seats stay theirs (spec §3).
    return v_none || jsonb_build_object('status', 'CONFIRMED_WINDOW_OPEN', 'release_after', v_release);
  end if;

  s := public.latest_snapshot(w.id);
  if s.id is null or s.observed_at < v_release then
    return v_none || jsonb_build_object('status', 'HEADCOUNT_NEEDED', 'release_after', v_release);
  end if;
  if now() - s.observed_at > make_interval(mins => public.meal_policy_int(ms.id, 'snapshot_validity_minutes')) then
    return v_none || jsonb_build_object('status', 'HEADCOUNT_STALE', 'snapshot_id', s.id);
  end if;

  v_close := case when v_has_res then ms.service_start_at else coalesce(w.admitting_at, w.opened_at) end
             + make_interval(mins => public.meal_policy_int(ms.id, 'admission_close_minutes_after_start'));
  if now() + make_interval(secs => public.meal_policy_int(ms.id, 'standby_response_seconds'))
           + make_interval(mins => public.meal_policy_int(ms.id, 'travel_allowance_minutes')) > v_close then
    return v_none || jsonb_build_object('status', 'TOO_LATE');
  end if;

  v_out := (select count(*) from public.standby_offers o
            where o.wave_id = w.id
              and (public.offer_holds_seat(o.state) or (o.state = 'VERIFIED_DINED' and o.dined_at > s.observed_at)))
         + (select count(*) from public.attendance_records r
            where r.wave_id = w.id and r.status = 'VALID'
              and r.reservation_prior_state = 'RELEASED' and r.recorded_at > s.observed_at);

  return jsonb_build_object(
    'status', 'OK',
    'vacancy', greatest(0, w.capacity - s.headcount - v_out),
    'capacity', w.capacity, 'headcount', s.headcount, 'outstanding', v_out, 'snapshot_id', s.id);
end $$;

-- ---------------------------------------------------------------------------
-- Offer table guard: the database-level backstop against over-invitation
-- ---------------------------------------------------------------------------

create function public.standby_offers_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_wave public.aisle_waves;
  v_part public.booking_participations;
begin
  if tg_op = 'DELETE' then
    raise exception 'offers are never deleted' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    select * into v_wave from public.aisle_waves where id = new.wave_id for update;
    if v_wave.phase <> 'ADMITTING' then
      raise exception 'offers can only be made for an admitting wave' using errcode = '23514';
    end if;
    if v_wave.meal_service_id <> new.meal_service_id or v_wave.aisle_code <> new.aisle_code then
      raise exception 'offer must match its wave' using errcode = '23514';
    end if;
    select * into v_part from public.booking_participations where id = new.participation_id;
    if v_part.meal_service_id <> new.meal_service_id or v_part.user_id <> new.user_id
       or v_part.coupon_id <> new.coupon_id or v_part.coupon_number <> new.coupon_number then
      raise exception 'offer must match its participation' using errcode = '23514';
    end if;
    if exists (select 1 from public.reservations
               where meal_service_id = new.meal_service_id and coupon_id = new.coupon_id
                 and public.reservation_holds_seat(state)) then
      raise exception 'coupon already holds a seat in this meal service' using errcode = '23514';
    end if;
    if (public.wave_vacancy(new.wave_id) ->> 'vacancy')::integer < 1 then
      raise exception 'no verified vacancy in this wave' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.meal_service_id <> old.meal_service_id or new.wave_id <> old.wave_id or new.aisle_code <> old.aisle_code
     or new.participation_id <> old.participation_id or new.user_id <> old.user_id
     or new.coupon_id <> old.coupon_id or new.coupon_number <> old.coupon_number
     or new.based_on_snapshot_id <> old.based_on_snapshot_id or new.offered_at <> old.offered_at then
    raise exception 'offer identity columns are immutable' using errcode = '42501';
  end if;
  if new.state <> old.state then
    new.state_changed_at := now();
  end if;
  return new;
end $$;

create trigger standby_offers_guard
  before insert or update or delete on public.standby_offers
  for each row execute function public.standby_offers_guard();

-- ---------------------------------------------------------------------------
-- Internal steps (callers hold meal service → wave locks)
-- ---------------------------------------------------------------------------

-- A headcount taken after a hold started waiting is the physical evidence
-- that frees it: if the person was there, they are inside O.
create function public.reconcile_wave_holds(p_wave_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.occupancy_snapshots := public.latest_snapshot(p_wave_id);
begin
  if s.id is null then
    return;
  end if;
  update public.reservations set state = 'RELEASED', state_reason = 'Seat freed by headcount'
  where wave_id = p_wave_id and state = 'EXPIRED_PENDING_RECONCILIATION' and state_changed_at < s.observed_at;
  update public.reservations set state = 'CANCELLED', state_reason = 'Cancellation confirmed by headcount'
  where wave_id = p_wave_id and state = 'CANCELLED_PENDING_VACANCY' and state_changed_at < s.observed_at;
  update public.standby_offers set state = 'RELEASED', state_reason = 'Seat freed by headcount'
  where wave_id = p_wave_id and state = 'EXPIRED_PENDING_RECONCILIATION' and state_changed_at < s.observed_at;
  update public.standby_offers set state = 'CANCELLED', state_reason = 'Cancellation confirmed by headcount'
  where wave_id = p_wave_id and state = 'CANCELLED_PENDING_VACANCY' and state_changed_at < s.observed_at;
end $$;

create function public.issue_offers_for_wave(p_wave_id uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  w public.aisle_waves;
  v jsonb;
  v_part public.booking_participations;
  v_part_id uuid;
  v_offer public.standby_offers;
  v_count integer := 0;
begin
  select * into w from public.aisle_waves where id = p_wave_id for update;
  perform public.reconcile_wave_holds(p_wave_id);
  v := public.wave_vacancy(p_wave_id);
  if v ->> 'status' <> 'OK' then
    return 0;
  end if;

  for i in 1 .. (v ->> 'vacancy')::integer loop
    v_part_id := public.next_standby_locked(w.meal_service_id);
    exit when v_part_id is null;
    select * into v_part from public.booking_participations where id = v_part_id;

    insert into public.standby_offers (
      meal_service_id, wave_id, aisle_code, participation_id, user_id, coupon_id, coupon_number,
      based_on_snapshot_id, respond_by)
    values (
      w.meal_service_id, w.id, w.aisle_code, v_part.id, v_part.user_id, v_part.coupon_id, v_part.coupon_number,
      (v ->> 'snapshot_id')::uuid,
      now() + make_interval(secs => public.meal_policy_int(w.meal_service_id, 'standby_response_seconds')))
    returning * into v_offer;

    update public.booking_participations set status = 'OFFERED' where id = v_part.id;

    perform public.enqueue_notification(v_part.user_id, 'STANDBY_OFFER', 'offer:' || v_offer.id,
      jsonb_build_object('offer_id', v_offer.id, 'aisle', w.aisle_code, 'respond_by', v_offer.respond_by,
                         'message', 'A place is available. Accept before the timer runs out.'));
    perform public.write_audit('STANDBY_OFFERED', 'standby_offer', v_offer.id::text, null,
      jsonb_build_object('coupon_number', v_offer.coupon_number, 'aisle', w.aisle_code,
                         'vacancy', v -> 'vacancy', 'headcount', v -> 'headcount', 'outstanding', v -> 'outstanding'));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- The one scheduled job. Safe to run as often as you like.
create function public.run_due_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms record;
  v_wave record;
  v_offer public.standby_offers;
  v_n integer;
  v_started integer := 0;
  v_gates integer := 0;
  v_unanswered integer := 0;
  v_missed_windows integer := 0;
  v_missed_arrivals integer := 0;
  v_offers integer := 0;
begin
  for v_ms in
    select id from public.meal_services
    where state = 'SCHEDULED' and service_start_at <= now()
    for update
  loop
    update public.meal_services set state = 'IN_SERVICE', state_changed_at = now() where id = v_ms.id;
    perform public.write_audit('MEAL_SERVICE_STATE_CHANGED', 'meal_service', v_ms.id::text,
      jsonb_build_object('state', 'SCHEDULED'), jsonb_build_object('state', 'IN_SERVICE'), 'Scheduled start');
    v_started := v_started + 1;
  end loop;

  for v_ms in select id from public.meal_services where state = 'IN_SERVICE' order by service_start_at loop
    perform 1 from public.meal_services where id = v_ms.id for update;
    perform 1 from public.aisle_waves where meal_service_id = v_ms.id and phase <> 'CLOSED' order by aisle_code for update;

    -- Gate opens for confirmed diners at T.
    update public.aisle_waves set phase = 'ADMITTING', admitting_at = coalesce(admitting_at, now())
    where meal_service_id = v_ms.id and phase = 'BOOKING';
    get diagnostics v_n = row_count;
    v_gates := v_gates + v_n;

    -- Unanswered offers: no penalty; back of the queue.
    for v_offer in
      select * from public.standby_offers
      where meal_service_id = v_ms.id and state = 'OFFERED' and respond_by < now()
    loop
      update public.standby_offers set state = 'EXPIRED_UNACKNOWLEDGED', state_reason = 'No response in time'
      where id = v_offer.id;
      update public.booking_participations set status = 'STANDBY', queued_at = now(), queue_tiebreak = random()
      where id = v_offer.participation_id and status = 'OFFERED';
      perform public.enqueue_notification(v_offer.user_id, 'OFFER_EXPIRED', 'offer-expired:' || v_offer.id,
        jsonb_build_object('message', 'Your offer expired; no admission right remains. You are back on the waitlist.'));
      v_unanswered := v_unanswered + 1;
    end loop;

    -- Accepted but not seen in the entry window: keep holding until a headcount.
    update public.standby_offers
    set state = 'EXPIRED_PENDING_RECONCILIATION', state_reason = 'Entry window ended without coupon record'
    where meal_service_id = v_ms.id and state = 'ACCEPTED' and entry_window_end < now();
    get diagnostics v_n = row_count;
    v_missed_windows := v_missed_windows + v_n;

    -- Confirmed bookers past their arrival time: priority lost, not yet a no-show.
    update public.reservations r
    set state = 'EXPIRED_PENDING_RECONCILIATION', state_reason = 'Arrival window ended without coupon record'
    where r.meal_service_id = v_ms.id and r.state = 'CONFIRMED' and r.arrive_by < now()
      and exists (select 1 from public.aisle_waves w where w.id = r.wave_id and w.phase <> 'CLOSED');
    get diagnostics v_n = row_count;
    v_missed_arrivals := v_missed_arrivals + v_n;

    for v_wave in
      select id from public.aisle_waves where meal_service_id = v_ms.id and phase = 'ADMITTING' order by aisle_code
    loop
      v_offers := v_offers + public.issue_offers_for_wave(v_wave.id);
    end loop;
  end loop;

  return jsonb_build_object('services_started', v_started, 'gates_opened', v_gates,
    'offers_unanswered', v_unanswered, 'entry_windows_missed', v_missed_windows,
    'arrivals_missed', v_missed_arrivals, 'offers_issued', v_offers);
end $$;

-- ---------------------------------------------------------------------------
-- Student API
-- ---------------------------------------------------------------------------

create function public.respond_to_offer(
  p_offer_id uuid, p_accept boolean, p_stay_in_queue boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_offer public.standby_offers;
  v_start timestamptz;
  v_interval integer;
  v_size integer;
begin
  select * into v_offer from public.standby_offers where id = p_offer_id and user_id = v_uid;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  perform 1 from public.meal_services where id = v_offer.meal_service_id for update;
  perform 1 from public.aisle_waves where id = v_offer.wave_id for update;
  perform 1 from public.booking_participations where id = v_offer.participation_id for update;
  select * into v_offer from public.standby_offers where id = p_offer_id for update;

  if v_offer.state <> 'OFFERED' then
    return jsonb_build_object('status', 'NOT_OPEN', 'offer_state', v_offer.state);
  end if;
  -- Server time decides; a phone with a wrong clock cannot extend the offer.
  if now() > v_offer.respond_by then
    update public.standby_offers set state = 'EXPIRED_UNACKNOWLEDGED', state_reason = 'Answered too late'
    where id = p_offer_id;
    update public.booking_participations set status = 'STANDBY', queued_at = now(), queue_tiebreak = random()
    where id = v_offer.participation_id;
    return jsonb_build_object('status', 'EXPIRED');
  end if;

  if not p_accept then
    update public.standby_offers set state = 'DECLINED', state_reason = 'Declined by student' where id = p_offer_id;
    update public.booking_participations
    set status = case when p_stay_in_queue then 'STANDBY'::public.participation_status else 'CANCELLED' end,
        queued_at = now(), queue_tiebreak = random()
    where id = v_offer.participation_id;
    perform public.write_audit('STANDBY_OFFER_DECLINED', 'standby_offer', p_offer_id::text, null,
      jsonb_build_object('stay_in_queue', p_stay_in_queue));
    return jsonb_build_object('status', 'DECLINED', 'in_queue', p_stay_in_queue);
  end if;

  -- Staggered entry: groups of `arrival_group_size` per `arrival_group_interval_minutes`,
  -- the first group no earlier than the travel allowance.
  v_interval := public.meal_policy_int(v_offer.meal_service_id, 'arrival_group_interval_minutes');
  v_size := public.meal_policy_int(v_offer.meal_service_id, 'arrival_group_size');
  v_start := date_trunc('minute', now() + make_interval(mins => public.meal_policy_int(v_offer.meal_service_id, 'travel_allowance_minutes'))
                                       + interval '59 seconds');
  while (select count(*) from public.standby_offers
         where wave_id = v_offer.wave_id and entry_window_start = v_start
           and state in ('ACCEPTED', 'VERIFIED_DINED', 'EXPIRED_PENDING_RECONCILIATION', 'CANCELLED_PENDING_VACANCY')) >= v_size loop
    v_start := v_start + make_interval(mins => v_interval);
  end loop;

  update public.standby_offers
  set state = 'ACCEPTED', accepted_at = now(),
      entry_window_start = v_start, entry_window_end = v_start + make_interval(mins => v_interval)
  where id = p_offer_id
  returning * into v_offer;
  update public.booking_participations set status = 'INVITED' where id = v_offer.participation_id;

  perform public.enqueue_notification(v_uid, 'INVITATION_ACCEPTED', 'invited:' || v_offer.id,
    jsonb_build_object('aisle', v_offer.aisle_code, 'entry_window_start', v_offer.entry_window_start,
                       'entry_window_end', v_offer.entry_window_end, 'coupon_number', v_offer.coupon_number));
  perform public.write_audit('STANDBY_OFFER_ACCEPTED', 'standby_offer', p_offer_id::text, null,
    jsonb_build_object('entry_window_start', v_offer.entry_window_start));

  return jsonb_build_object('status', 'ACCEPTED', 'aisle', v_offer.aisle_code,
    'entry_window_start', v_offer.entry_window_start, 'entry_window_end', v_offer.entry_window_end);
end $$;

create function public.my_notifications(p_limit integer default 20) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'payload', payload, 'created_at', created_at)
                            order by created_at desc), '[]'::jsonb)
  from (select * from public.notification_outbox
        where recipient_id = (select public.require_role('STUDENT'))
        order by created_at desc limit least(greatest(p_limit, 1), 100)) n
$$;

-- What the student sees for their participation, including a live offer.
create or replace function public.participation_status_json(p_participation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_part public.booking_participations;
  v_res public.reservations;
  v_offer public.standby_offers;
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

  if v_part.status in ('OFFERED', 'INVITED') then
    select * into v_offer from public.standby_offers
    where participation_id = v_part.id order by offered_at desc limit 1;
    return jsonb_build_object(
      'participation', v_part.status,
      'coupon_number', v_part.coupon_number,
      'offer_id', v_offer.id,
      'offer_state', v_offer.state,
      'aisle', v_offer.aisle_code,
      'respond_by', v_offer.respond_by,
      'entry_window_start', v_offer.entry_window_start,
      'entry_window_end', v_offer.entry_window_end);
  end if;

  select * into v_res from public.reservations
  where participation_id = v_part.id order by created_at desc limit 1;
  if v_res.id is null then
    select * into v_offer from public.standby_offers
    where participation_id = v_part.id order by offered_at desc limit 1;
  end if;
  return jsonb_build_object(
    'participation', v_part.status,
    'coupon_number', v_part.coupon_number,
    'reservation_state', v_res.state,
    'offer_state', v_offer.state,
    'booking_ref', v_res.booking_ref,
    'aisle', coalesce(v_res.aisle_code, v_offer.aisle_code),
    'arrive_by', v_res.arrive_by);
end $$;

create or replace function public.cancel_booking(p_meal_service_id uuid, p_idempotency_key text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_action text := 'cancel_booking:' || p_meal_service_id;
  v_prior jsonb;
  v_service public.meal_services;
  v_part public.booking_participations;
  v_res public.reservations;
  v_offer public.standby_offers;
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

  if v_part.status in ('OFFERED', 'INVITED') then
    select * into v_offer from public.standby_offers
    where participation_id = v_part.id and state in ('OFFERED', 'ACCEPTED') order by offered_at desc limit 1;
    if v_offer.id is null then
      return jsonb_build_object('status', 'NOT_CANCELLABLE');
    end if;
    perform 1 from public.aisle_waves where id = v_offer.wave_id for update;
    perform 1 from public.booking_participations where id = v_part.id for update;
    select * into v_offer from public.standby_offers where id = v_offer.id for update;
    update public.booking_participations set status = 'CANCELLED' where id = v_part.id;
    if v_offer.state = 'OFFERED' then
      update public.standby_offers set state = 'DECLINED', state_reason = 'Cancelled by student' where id = v_offer.id;
      v_result := jsonb_build_object('status', 'CANCELLED', 'seat_released', true, 'promoted', 0);
    else
      -- They might already be walking in or seated: hold until a headcount.
      update public.standby_offers set state = 'CANCELLED_PENDING_VACANCY', state_reason = 'Cancelled by student after accepting'
      where id = v_offer.id;
      v_result := jsonb_build_object('status', 'CANCELLED', 'seat_released', false, 'promoted', 0);
    end if;
    perform public.write_audit('STANDBY_INVITATION_CANCELLED', 'standby_offer', v_offer.id::text,
      jsonb_build_object('state', v_offer.state), v_result);
    return public.idem_store(p_idempotency_key, v_action, v_result);
  end if;

  select * into v_res from public.reservations
  where participation_id = v_part.id and public.reservation_holds_seat(state);
  if v_res.id is null then
    return jsonb_build_object('status', 'NOT_CANCELLABLE');
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
    update public.reservations set state = 'CANCELLED', state_reason = 'Cancelled by student before gate opened'
    where id = v_res.id;
    v_promoted := public.fill_from_standby_locked(p_meal_service_id);
    v_result := jsonb_build_object('status', 'CANCELLED', 'seat_released', true, 'promoted', v_promoted);
  else
    update public.reservations
    set state = 'CANCELLED_PENDING_VACANCY', state_reason = 'Cancelled by student after gate opened'
    where id = v_res.id;
    v_result := jsonb_build_object('status', 'CANCELLED', 'seat_released', false, 'promoted', 0);
  end if;

  perform public.write_audit('RESERVATION_CANCELLED', 'reservation', v_res.id::text,
    jsonb_build_object('state', v_res.state), v_result);
  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

-- ---------------------------------------------------------------------------
-- Attendance, now aware of invitations
-- ---------------------------------------------------------------------------

create or replace function public.attendance_result_json(p_record public.attendance_records) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'status', case when p_record.exception is null then 'RECORDED' else 'RECORDED_WITH_EXCEPTION' end,
    'exception', p_record.exception,
    'record_id', p_record.id,
    'coupon_number', p_record.coupon_number,
    'aisle', p_record.aisle_code,
    'recorded_at', p_record.recorded_at,
    'holder_name', (select full_name from public.profiles where id = p_record.holder_user_id),
    'booking_ref', coalesce((select booking_ref from public.reservations where id = p_record.reservation_id),
                            case when p_record.offer_id is not null then 'Standby invitation' end))
$$;

create or replace function public.record_coupon(
  p_wave_id uuid,
  p_coupon_number integer,
  p_client_entry_id text,
  p_source public.attendance_source default 'LIVE',
  p_observed_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_wave public.aisle_waves;
  v_coupon public.coupons;
  v_rec public.attendance_records;
  v_res public.reservations;
  v_offer public.standby_offers;
  v_holder uuid;
  v_exception public.attendance_exception;
  v_res_prior public.reservation_state;
  v_offer_prior public.offer_state;
begin
  if p_client_entry_id is null then
    raise exception 'client_entry_id is required' using errcode = '22023';
  end if;
  if p_observed_at is not null and p_observed_at > now() + interval '1 minute' then
    raise exception 'observed_at cannot be in the future' using errcode = '22023';
  end if;

  select * into v_wave from public.aisle_waves where id = p_wave_id for share;
  if not found then
    raise exception 'wave not found' using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('attend:' || v_wave.meal_service_id || ':' || p_coupon_number, 0));

  select * into v_rec from public.attendance_records where client_entry_id = p_client_entry_id;
  if found then
    if v_rec.recorded_by <> v_uid or v_rec.wave_id <> p_wave_id or v_rec.coupon_number <> p_coupon_number then
      raise exception 'client_entry_id was already used for a different entry' using errcode = '22023';
    end if;
    return public.attendance_result_json(v_rec) || jsonb_build_object('replayed', true);
  end if;

  if v_wave.phase = 'CLOSED' and p_source = 'LIVE' then
    return jsonb_build_object('status', 'WAVE_CLOSED');
  end if;

  select * into v_coupon from public.coupons where coupon_number = p_coupon_number and status = 'ACTIVE';
  if not found then
    return jsonb_build_object('status', 'UNKNOWN_COUPON', 'coupon_number', p_coupon_number);
  end if;

  select * into v_rec from public.attendance_records
  where meal_service_id = v_wave.meal_service_id and coupon_id = v_coupon.id and status = 'VALID';
  if found then
    return jsonb_build_object('status', 'ALREADY_RECORDED', 'coupon_number', p_coupon_number,
                              'aisle', v_rec.aisle_code, 'recorded_at', v_rec.recorded_at,
                              'record_id', v_rec.id);
  end if;

  select user_id into v_holder from public.coupon_claims where coupon_id = v_coupon.id and status = 'APPROVED';

  -- A booking that may still be honoured: confirmed, waiting for a headcount, or released by one
  -- (a late coupon for someone who was seated all along).
  select * into v_res from public.reservations
  where meal_service_id = v_wave.meal_service_id and coupon_id = v_coupon.id
    and state in ('CONFIRMED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION', 'RELEASED')
  order by created_at desc limit 1
  for update;

  if v_res.id is not null then
    if v_res.wave_id <> p_wave_id then
      v_exception := 'WRONG_WAVE';
    else
      v_res_prior := v_res.state;
      update public.reservations set state = 'VERIFIED_DINED', state_reason = 'Coupon collected by attendant'
      where id = v_res.id;
    end if;
  else
    select * into v_offer from public.standby_offers
    where meal_service_id = v_wave.meal_service_id and coupon_id = v_coupon.id
      and state in ('OFFERED', 'ACCEPTED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION', 'RELEASED')
    order by offered_at desc limit 1
    for update;
    if v_offer.id is null then
      v_exception := 'NOT_INVITED';
    elsif v_offer.wave_id <> p_wave_id then
      v_exception := 'WRONG_WAVE';
    else
      v_offer_prior := v_offer.state;
      update public.standby_offers
      set state = 'VERIFIED_DINED', dined_at = now(), state_reason = 'Coupon collected by attendant'
      where id = v_offer.id;
    end if;
  end if;

  insert into public.coupon_collection_rounds (wave_id, meal_service_id, aisle_code, started_by)
  values (p_wave_id, v_wave.meal_service_id, v_wave.aisle_code, v_uid)
  on conflict (wave_id) do nothing;

  insert into public.attendance_records (
    meal_service_id, wave_id, aisle_code, coupon_id, coupon_number, holder_user_id,
    reservation_id, reservation_prior_state, offer_id, offer_prior_state,
    exception, source, client_entry_id, recorded_by, observed_at
  )
  values (
    v_wave.meal_service_id, p_wave_id, v_wave.aisle_code, v_coupon.id, p_coupon_number, v_holder,
    v_res.id, v_res_prior, v_offer.id, v_offer_prior,
    v_exception, p_source, p_client_entry_id, v_uid,
    case when p_source = 'LIVE' then null else p_observed_at end
  )
  returning * into v_rec;

  return public.attendance_result_json(v_rec);
end $$;

create or replace function public.void_attendance(p_record_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_rec public.attendance_records;
  v_wave public.aisle_waves;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_rec from public.attendance_records where id = p_record_id;
  if not found then
    raise exception 'attendance record not found' using errcode = 'P0002';
  end if;
  select * into v_wave from public.aisle_waves where id = v_rec.wave_id for share;
  perform pg_advisory_xact_lock(hashtextextended('attend:' || v_rec.meal_service_id || ':' || v_rec.coupon_number, 0));
  select * into v_rec from public.attendance_records where id = p_record_id for update;
  if v_rec.status = 'VOIDED' then
    return jsonb_build_object('status', 'ALREADY_VOIDED');
  end if;

  if v_rec.reservation_prior_state is not null then
    update public.reservations
    set state = case
          when v_wave.phase = 'CLOSED' and v_rec.reservation_prior_state = 'CONFIRMED'
            then 'EXPIRED_PENDING_RECONCILIATION'::public.reservation_state
          when v_wave.phase = 'CLOSED' and v_rec.reservation_prior_state = 'CANCELLED_PENDING_VACANCY'
            then 'CANCELLED'::public.reservation_state
          else v_rec.reservation_prior_state
        end,
        state_reason = 'Attendance entry voided: ' || p_reason
    where id = v_rec.reservation_id and state = 'VERIFIED_DINED';
  end if;

  if v_rec.offer_prior_state is not null then
    update public.standby_offers
    set state = case
          when v_wave.phase = 'CLOSED' and v_rec.offer_prior_state in ('OFFERED', 'ACCEPTED')
            then 'EXPIRED_PENDING_RECONCILIATION'::public.offer_state
          when v_wave.phase = 'CLOSED' and v_rec.offer_prior_state = 'CANCELLED_PENDING_VACANCY'
            then 'CANCELLED'::public.offer_state
          else v_rec.offer_prior_state
        end,
        dined_at = null,
        state_reason = 'Attendance entry voided: ' || p_reason
    where id = v_rec.offer_id and state = 'VERIFIED_DINED';
  end if;

  update public.attendance_records
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = p_reason
  where id = p_record_id;

  perform public.write_audit('ATTENDANCE_VOIDED', 'attendance_record', p_record_id::text,
    jsonb_build_object('coupon_number', v_rec.coupon_number, 'status', 'VALID'),
    jsonb_build_object('status', 'VOIDED'), p_reason);
  return jsonb_build_object('status', 'VOIDED');
end $$;

-- ---------------------------------------------------------------------------
-- Waves, now aware of invitations
-- ---------------------------------------------------------------------------

-- A wave opened while the meal is already running (a turnover) starts
-- admitting immediately, with a headcount of 0 attested by the person who
-- just confirmed the aisle empty, so invitations flow at once (spec §4.3).
create or replace function public.open_aisle_wave_locked(
  p_aisle public.aisle_code, p_meal_service_id uuid, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_aisle public.aisles;
  v_service public.meal_services;
  v_wave public.aisle_waves;
  v_capacity smallint;
  v_promoted integer := 0;
  v_turnover boolean;
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

  v_turnover := now() >= v_service.service_start_at;
  if v_turnover then
    update public.aisle_waves set phase = 'ADMITTING', admitting_at = now() where id = v_wave.id;
    insert into public.occupancy_snapshots (wave_id, meal_service_id, aisle_code, headcount, taken_by)
    values (v_wave.id, p_meal_service_id, p_aisle, 0, p_actor);
  else
    v_promoted := public.fill_from_standby_locked(p_meal_service_id);
  end if;

  perform public.write_audit('AISLE_WAVE_OPENED', 'aisle_wave', v_wave.id::text,
    jsonb_build_object('aisle_readiness', v_aisle.readiness),
    to_jsonb(v_wave) || jsonb_build_object('turnover', v_turnover));

  return jsonb_build_object('status', 'WAVE_OPENED', 'wave_id', v_wave.id,
                            'wave_number', v_wave.wave_number, 'capacity', v_wave.capacity,
                            'promoted_from_standby', v_promoted, 'admitting', v_turnover);
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

  update public.reservations
  set state = 'EXPIRED_PENDING_RECONCILIATION', state_reason = 'Wave closed without coupon record'
  where wave_id = p_wave_id and state = 'CONFIRMED';
  get diagnostics v_expired = row_count;
  update public.reservations set state = 'CANCELLED', state_reason = 'Aisle confirmed empty'
  where wave_id = p_wave_id and state = 'CANCELLED_PENDING_VACANCY';

  -- Unanswered offers for this wave lapse without blame; the students go back to the queue.
  with lapsed as (
    update public.standby_offers set state = 'EXPIRED_UNACKNOWLEDGED', state_reason = 'Wave closed'
    where wave_id = p_wave_id and state = 'OFFERED'
    returning participation_id
  )
  update public.booking_participations set status = 'STANDBY'
  where id in (select participation_id from lapsed) and status = 'OFFERED';
  update public.standby_offers
  set state = 'EXPIRED_PENDING_RECONCILIATION', state_reason = 'Wave closed without coupon record'
  where wave_id = p_wave_id and state = 'ACCEPTED';
  update public.standby_offers set state = 'CANCELLED', state_reason = 'Aisle confirmed empty'
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

-- ---------------------------------------------------------------------------
-- Operator controls and read models
-- ---------------------------------------------------------------------------

-- Emergency "pause invitations"; attendance collection is unaffected (spec §13.10).
create function public.set_invitations_paused(p_meal_service_id uuid, p_paused boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_service public.meal_services;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_service from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;
  if v_service.invitations_paused = p_paused then
    return jsonb_build_object('status', 'UNCHANGED');
  end if;
  update public.meal_services
  set invitations_paused = p_paused, invitations_paused_reason = case when p_paused then p_reason end
  where id = p_meal_service_id;
  perform public.write_audit(case when p_paused then 'INVITATIONS_PAUSED' else 'INVITATIONS_RESUMED' end,
    'meal_service', p_meal_service_id::text, null, null, p_reason);
  return jsonb_build_object('status', 'OK', 'paused', p_paused);
end $$;

-- attendant_board plus what the invitation engine is waiting for, per aisle.
create or replace function public.attendant_board(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_validity integer;
begin
  perform public.require_role('ATTENDANT');
  v_validity := public.meal_policy_int(p_meal_service_id, 'snapshot_validity_minutes');
  return coalesce((
    select jsonb_agg(card order by aisle_code)
    from (
      select a.code as aisle_code, jsonb_build_object(
        'aisle', a.code,
        'display_state', st.display_state,
        'wave_id', w.id,
        'wave_number', w.wave_number,
        'phase', w.phase,
        'capacity', w.capacity,
        'held_seats', w.held_seats,
        'coupon_entries', (select count(*) from public.attendance_records r
                           where r.wave_id = w.id and r.status = 'VALID'),
        'open_exceptions', (select count(*) from public.attendance_records r
                            where r.wave_id = w.id and r.status = 'VALID'
                              and r.exception is not null and r.exception_resolved_at is null),
        'snapshot', case when s.id is null then null else jsonb_build_object(
          'snapshot_id', s.id,
          'headcount', s.headcount,
          'observed_at', s.observed_at,
          'age_seconds', floor(extract(epoch from now() - s.observed_at))::integer,
          'stale', now() - s.observed_at > make_interval(mins => v_validity)) end,
        'physically_vacant', case when s.id is null then null else greatest(0, w.capacity - s.headcount) end,
        'round', coalesce((select r.status from public.coupon_collection_rounds r where r.wave_id = w.id), 'NOT_STARTED'),
        'invitations', case when w.id is null then null else public.wave_vacancy(w.id) end,
        'invitations_out', (select count(*) from public.standby_offers o
                            where o.wave_id = w.id and public.offer_holds_seat(o.state))
      ) as card
      from public.aisles a
      join public.aisle_status st on st.aisle_code = a.code
      left join public.aisle_waves w on w.id = a.current_wave_id and w.meal_service_id = p_meal_service_id
      left join lateral (select * from public.latest_snapshot(w.id)) s on true
    ) cards
  ), '[]'::jsonb);
end $$;

create function public.admin_overview(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
begin
  perform public.require_role('ADMIN');
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'meal', jsonb_build_object('id', v_ms.id, 'service_date', v_ms.service_date, 'meal_type', v_ms.meal_type,
                               'service_start_at', v_ms.service_start_at, 'state', v_ms.state,
                               'invitations_paused', v_ms.invitations_paused,
                               'invitations_paused_reason', v_ms.invitations_paused_reason,
                               'policy_version', v_ms.policy_version),
    'now', now(),
    'window', public.booking_window(v_ms.id),
    'participants', (select jsonb_object_agg(status, n) from (
                       select status, count(*) as n from public.booking_participations
                       where meal_service_id = v_ms.id group by status) x),
    'offers', (select jsonb_object_agg(state, n) from (
                 select state, count(*) as n from public.standby_offers
                 where meal_service_id = v_ms.id group by state) x),
    'reservations', (select jsonb_object_agg(state, n) from (
                       select state, count(*) as n from public.reservations
                       where meal_service_id = v_ms.id group by state) x),
    'diners_verified', (select count(*) from public.attendance_records
                        where meal_service_id = v_ms.id and status = 'VALID'),
    'aisles', public.attendant_board(v_ms.id),
    'alerts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'payload', payload,
                                                            'created_at', created_at) order by created_at desc)
                        from (select * from public.admin_alerts where status = 'OPEN'
                              order by created_at desc limit 10) a), '[]'::jsonb),
    'pending_claims', (select count(*) from public.coupon_claims where status = 'PENDING'),
    -- Who is invited right now (admins may see identities; spec §14).
    'invitations', coalesce((select jsonb_agg(jsonb_build_object(
                     'coupon_number', o.coupon_number, 'name', p.full_name, 'aisle', o.aisle_code, 'state', o.state,
                     'respond_by', o.respond_by, 'entry_window_start', o.entry_window_start,
                     'entry_window_end', o.entry_window_end) order by o.offered_at desc, o.coupon_number)
                   from public.standby_offers o join public.profiles p on p.id = o.user_id
                   join public.aisle_waves w on w.id = o.wave_id
                   where o.meal_service_id = v_ms.id and w.phase <> 'CLOSED'
                     and o.state in ('OFFERED', 'ACCEPTED', 'VERIFIED_DINED', 'EXPIRED_PENDING_RECONCILIATION')), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('at', occurred_at, 'action', action,
                                                            'after', after, 'reason', reason) order by id desc)
                        from (select * from public.audit_log order by id desc limit 15) l), '[]'::jsonb));
end $$;

-- Who the signed-in user is: name, role and verified coupon (null if none).
create function public.my_profile() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.full_name, 'role', p.role, 'is_verified', p.is_verified,
    'coupon_number', (select k.coupon_number from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
                      where c.user_id = p.id and c.status = 'APPROVED'))
  from public.profiles p where p.id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.standby_offers enable row level security;
create policy standby_offers_select on public.standby_offers for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ATTENDANT');
grant select on public.standby_offers to authenticated;

grant execute on function
  public.respond_to_offer(uuid, boolean, boolean),
  public.my_notifications(integer),
  public.set_invitations_paused(uuid, boolean, text),
  public.admin_overview(uuid),
  public.my_profile()
to authenticated;
-- run_due_jobs() is deliberately not granted: only the scheduler (postgres / service role) runs it.
