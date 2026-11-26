-- Phase 6 — no-show accountability: gentle, evidence-based and reversible (spec §9).
--
--   Candidate   a confirmed booking or accepted invitation whose time ran out
--               (EXPIRED_PENDING_RECONCILIATION or RELEASED) and whose coupon
--               has no valid attendance anywhere in that meal service.
--   PENDING     recorded as soon as it is a candidate; never counted.
--   VERIFIED    only after the attendant has FINISHED that wave's coupon round
--               and the wave is closed or `no_show_grace_minutes` have passed.
--   REVERSED    the coupon was recorded after all (late entry, paper list);
--               voiding that entry puts the event back to PENDING.
--   EXCUSED     an admin accepted an explanation or found a staff mistake.
--
-- Ladder over a rolling `penalty_window_days` of VERIFIED events (per student,
-- never per coupon, so a reissued coupon carries nothing to its next holder):
--   1 private reminder · 2 private warning · 3 one meal of reduced booking
--   priority + one admin alert · 4+ flagged for human review (no automatic
--   extra penalty). Excusing or reversing an event re-checks every step that
--   depended on it and undoes those that no longer hold.
--
-- Cancelling in time, never being offered a seat, or ignoring an offer you
-- never accepted are never candidates.

insert into public.policy_settings (version, settings, is_active, note)
select 3, settings || jsonb_build_object('no_show_grace_minutes', 30), false,
       'Phase 6: no-shows become final 30 minutes after the coupon round is finished (or when the aisle closes)'
from public.policy_settings where version = 2;
update public.policy_settings set is_active = false where version = 2;
update public.policy_settings set is_active = true where version = 3;

create type public.no_show_status as enum ('PENDING', 'VERIFIED', 'EXCUSED', 'REVERSED');
create type public.commitment_kind as enum ('BOOKING', 'INVITATION');
create type public.penalty_level as enum ('REMINDER', 'WARNING', 'PRIORITY_REDUCTION', 'REVIEW');

create table public.no_show_events (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  wave_id uuid not null references public.aisle_waves (id),
  aisle_code public.aisle_code not null,
  user_id uuid not null references public.profiles (id),
  coupon_id uuid not null references public.coupons (id),
  coupon_number integer not null,
  commitment public.commitment_kind not null,
  reservation_id uuid unique references public.reservations (id),
  offer_id uuid unique references public.standby_offers (id),
  status public.no_show_status not null default 'PENDING',
  detected_at timestamptz not null default now(),
  verified_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references public.profiles (id),
  reason text,
  reversed_by_attendance_id uuid references public.attendance_records (id),
  policy_version integer references public.policy_settings (version),
  constraint no_show_one_commitment check (
    (commitment = 'BOOKING' and reservation_id is not null and offer_id is null)
    or (commitment = 'INVITATION' and offer_id is not null and reservation_id is null))
);

create index no_show_events_user_idx on public.no_show_events (user_id, status);
create index no_show_events_meal_idx on public.no_show_events (meal_service_id, status);
create index no_show_events_wave_idx on public.no_show_events (wave_id, status);

create function public.no_show_events_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'no-show records are never deleted' using errcode = '42501';
  end if;
  if new.meal_service_id <> old.meal_service_id or new.wave_id <> old.wave_id or new.user_id <> old.user_id
     or new.coupon_id <> old.coupon_id or new.coupon_number <> old.coupon_number or new.commitment <> old.commitment
     or new.reservation_id is distinct from old.reservation_id or new.offer_id is distinct from old.offer_id
     or new.detected_at <> old.detected_at then
    raise exception 'no-show identity columns are immutable' using errcode = '42501';
  end if;
  if old.status = 'EXCUSED' and new.status <> 'EXCUSED' then
    raise exception 'an excused no-show is final' using errcode = '42501';
  end if;
  if new.status <> old.status and not (
    (old.status = 'PENDING' and new.status in ('VERIFIED', 'REVERSED', 'EXCUSED'))
    or (old.status = 'VERIFIED' and new.status in ('REVERSED', 'EXCUSED'))
    or (old.status = 'REVERSED' and new.status = 'PENDING')
  ) then
    raise exception 'invalid no-show transition % -> %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end $$;

create trigger no_show_events_guard
  before update or delete on public.no_show_events
  for each row execute function public.no_show_events_guard();

create table public.penalty_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  no_show_event_id uuid not null unique references public.no_show_events (id),  -- one ladder step per offence
  level public.penalty_level not null,
  count_in_window integer not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CONSUMED', 'REVERSED')),
  applied_at timestamptz not null default now(),
  consumed_at timestamptz,
  consumed_meal_service_id uuid references public.meal_services (id),
  reversed_at timestamptz,
  reversed_reason text,
  constraint penalty_consumed_shape check ((status = 'CONSUMED') = (consumed_at is not null) or status = 'REVERSED')
);

create index penalty_events_user_idx on public.penalty_events (user_id, status);

create table public.no_show_appeals (
  id uuid primary key default gen_random_uuid(),
  no_show_event_id uuid not null unique references public.no_show_events (id),
  user_id uuid not null references public.profiles (id),
  explanation text not null check (char_length(btrim(explanation)) between 1 and 1000),
  status text not null default 'OPEN' check (status in ('OPEN', 'EXCUSED', 'UPHELD')),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles (id),
  decision_reason text
);

create trigger penalty_events_no_delete before delete on public.penalty_events
  for each row execute function public.append_only();
create trigger no_show_appeals_no_delete before delete on public.no_show_appeals
  for each row execute function public.append_only();

-- ---------------------------------------------------------------------------
-- The ladder
-- ---------------------------------------------------------------------------

-- VERIFIED no-shows of a student in the window ending at p_at (by meal time).
create function public.no_show_count(p_user_id uuid, p_at timestamptz) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer
  from public.no_show_events e join public.meal_services m on m.id = e.meal_service_id
  where e.user_id = p_user_id and e.status = 'VERIFIED'
    and m.service_start_at > p_at - make_interval(days => public.policy_int('penalty_window_days'))
    and m.service_start_at <= p_at
$$;

create function public.penalty_threshold(p_level public.penalty_level) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select public.policy_int(case p_level
    when 'REMINDER' then 'penalty_reminder_at' when 'WARNING' then 'penalty_warning_at'
    when 'PRIORITY_REDUCTION' then 'penalty_priority_reduction_at' else 'penalty_review_at' end)
$$;

-- The step a student's n-th no-show in the window reaches (null below the first threshold).
create function public.penalty_level_for(p_count integer) returns public.penalty_level
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_count >= public.penalty_threshold('REVIEW') then 'REVIEW'
    when p_count >= public.penalty_threshold('PRIORITY_REDUCTION') then 'PRIORITY_REDUCTION'
    when p_count >= public.penalty_threshold('WARNING') then 'WARNING'
    when p_count >= public.penalty_threshold('REMINDER') then 'REMINDER'
  end::public.penalty_level
$$;

create function public.penalty_message(p_level public.penalty_level, p_count integer) returns text
language sql immutable as $$
  select case p_level
    when 'REMINDER' then 'Our records show you had a place for a meal but were not recorded at it. If that is wrong, you can explain in your history. Please cancel when you can’t come, so someone on standby gets the seat.'
    when 'WARNING' then 'This is the second meal in 30 days where you had a place but were not recorded. Please cancel in the app whenever you can’t come. If a record is wrong, explain it in your history.'
    when 'PRIORITY_REDUCTION' then 'After ' || p_count || ' missed meals in 30 days, your next booking will go to the standby list instead of a confirmed seat. You can still eat if a seat is free. If a record is wrong, explain it in your history.'
    else 'Your missed meals are being reviewed by the hall admin. You can explain any of them in your history.'
  end
$$;

-- Applies the ladder step for one newly VERIFIED event (idempotent).
create function public.apply_penalty_for(p_event_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.no_show_events;
  v_at timestamptz;
  v_n integer;
  v_level public.penalty_level;
  v_penalty public.penalty_events;
begin
  select * into e from public.no_show_events where id = p_event_id;
  if e.status <> 'VERIFIED' then
    return;
  end if;
  select service_start_at into v_at from public.meal_services where id = e.meal_service_id;
  v_n := public.no_show_count(e.user_id, v_at);
  v_level := public.penalty_level_for(v_n);
  if v_level is null then
    return;
  end if;

  -- A step undone earlier (late coupon later voided) comes back into force.
  insert into public.penalty_events (user_id, no_show_event_id, level, count_in_window)
  values (e.user_id, e.id, v_level, v_n)
  on conflict (no_show_event_id) do update
    set status = 'ACTIVE', level = excluded.level, count_in_window = excluded.count_in_window, applied_at = now(),
        reversed_at = null, reversed_reason = null, consumed_at = null, consumed_meal_service_id = null
    where penalty_events.status = 'REVERSED'
  returning * into v_penalty;
  if v_penalty.id is null then
    return;
  end if;

  perform public.enqueue_notification(e.user_id, 'NO_SHOW_' || v_level,
    'penalty:' || v_penalty.id || ':' || extract(epoch from v_penalty.applied_at),
    jsonb_build_object('message', public.penalty_message(v_level, v_n), 'count', v_n,
                       'coupon_number', e.coupon_number, 'meal_service_id', e.meal_service_id));

  if v_level in ('PRIORITY_REDUCTION', 'REVIEW') then
    -- One alert per threshold event, never one per page view or job run.
    perform public.raise_admin_alert(
      case when v_level = 'REVIEW' then 'NO_SHOW_REVIEW' else 'REPEATED_NO_SHOWS' end,
      'no-show-threshold:' || v_penalty.id || ':' || extract(epoch from v_penalty.applied_at),
      jsonb_build_object('user_id', e.user_id, 'coupon_number', e.coupon_number, 'count', v_n,
                         'name', (select full_name from public.profiles where id = e.user_id)));
  end if;

  perform public.write_audit('PENALTY_APPLIED', 'penalty_event', v_penalty.id::text, null,
    jsonb_build_object('level', v_level, 'count', v_n, 'coupon_number', e.coupon_number, 'user_id', e.user_id));
end $$;

-- Re-grades a student's ladder after an offence is excused or reversed (spec §9.3):
-- each remaining step is set to what its offence's count now reaches; steps of
-- offences that no longer count are reversed. Steps only ever go down here, and
-- a lowered step lifts the reduced priority and the admin alert it caused.
create function public.recompute_penalties(p_user_id uuid, p_reason text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  p record;
  v_n integer;
  v_level public.penalty_level;
  v_count integer := 0;
begin
  for p in
    select pe.*, e.status as event_status, m.service_start_at
    from public.penalty_events pe
    join public.no_show_events e on e.id = pe.no_show_event_id
    join public.meal_services m on m.id = e.meal_service_id
    where pe.user_id = p_user_id and pe.status in ('ACTIVE', 'CONSUMED')
    order by m.service_start_at
    for update of pe
  loop
    v_n := case when p.event_status = 'VERIFIED' then public.no_show_count(p_user_id, p.service_start_at) else 0 end;
    v_level := public.penalty_level_for(v_n);
    continue when v_level is not distinct from p.level;

    if v_level is null then
      update public.penalty_events
      set status = 'REVERSED', reversed_at = now(), reversed_reason = p_reason
      where id = p.id;
    else
      update public.penalty_events
      set level = v_level, count_in_window = v_n, status = 'ACTIVE', consumed_at = null, consumed_meal_service_id = null
      where id = p.id;
    end if;

    if p.level = 'PRIORITY_REDUCTION' and p.consumed_meal_service_id is not null then
      -- Lift a reduced priority already applied to a meal that has not ended.
      update public.booking_participations bp set priority_tier = 0
      where bp.user_id = p_user_id and bp.meal_service_id = p.consumed_meal_service_id and bp.priority_tier > 0
        and exists (select 1 from public.meal_services m
                    where m.id = bp.meal_service_id and m.state in ('SCHEDULED', 'IN_SERVICE'));
    end if;
    if p.level in ('PRIORITY_REDUCTION', 'REVIEW') then
      update public.admin_alerts set status = 'RESOLVED', acknowledged_at = coalesce(acknowledged_at, now())
      where dedup_key like 'no-show-threshold:' || p.id || ':%' and status <> 'RESOLVED';
    end if;

    perform public.enqueue_notification(p_user_id, 'PENALTY_LIFTED', 'penalty-lifted:' || p.id || ':' || extract(epoch from clock_timestamp()),
      jsonb_build_object('message', 'A missed-meal record was corrected, so a related notice was lowered or withdrawn.'));
    perform public.write_audit('PENALTY_REGRADED', 'penalty_event', p.id::text,
      jsonb_build_object('level', p.level, 'status', p.status),
      jsonb_build_object('level', v_level, 'status', case when v_level is null then 'REVERSED' else 'ACTIVE' end), p_reason);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Detection and verification (called by the scheduler)
-- ---------------------------------------------------------------------------

create function public.process_no_shows() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e record;
  v_detected integer := 0;
  v_n integer;
  v_verified integer := 0;
begin
  insert into public.no_show_events (meal_service_id, wave_id, aisle_code, user_id, coupon_id, coupon_number,
                                     commitment, reservation_id)
  select r.meal_service_id, r.wave_id, r.aisle_code, r.user_id, r.coupon_id, r.coupon_number, 'BOOKING', r.id
  from public.reservations r
  where r.state in ('EXPIRED_PENDING_RECONCILIATION', 'RELEASED')
    and not exists (select 1 from public.attendance_records a
                    where a.meal_service_id = r.meal_service_id and a.coupon_id = r.coupon_id and a.status = 'VALID')
  on conflict (reservation_id) do nothing;
  get diagnostics v_n = row_count;
  v_detected := v_n;

  insert into public.no_show_events (meal_service_id, wave_id, aisle_code, user_id, coupon_id, coupon_number,
                                     commitment, offer_id)
  select o.meal_service_id, o.wave_id, o.aisle_code, o.user_id, o.coupon_id, o.coupon_number, 'INVITATION', o.id
  from public.standby_offers o
  where o.state in ('EXPIRED_PENDING_RECONCILIATION', 'RELEASED') and o.accepted_at is not null
    and not exists (select 1 from public.attendance_records a
                    where a.meal_service_id = o.meal_service_id and a.coupon_id = o.coupon_id and a.status = 'VALID')
  on conflict (offer_id) do nothing;
  get diagnostics v_n = row_count;
  v_detected := v_detected + v_n;

  -- Only a FINISHED coupon round can turn a candidate into a no-show (spec I9, §9.4).
  for e in
    select ev.id, ev.user_id, ev.meal_service_id, ev.coupon_id
    from public.no_show_events ev
    join public.coupon_collection_rounds c on c.wave_id = ev.wave_id and c.status = 'FINISHED'
    join public.aisle_waves w on w.id = ev.wave_id
    join public.meal_services m on m.id = ev.meal_service_id
    where ev.status = 'PENDING'
      and (w.phase = 'CLOSED'
           or c.finished_at + make_interval(mins => public.meal_policy_int(ev.meal_service_id, 'no_show_grace_minutes')) < now())
    order by m.service_start_at, ev.detected_at
    for update of ev
  loop
    if exists (select 1 from public.attendance_records a
               where a.meal_service_id = e.meal_service_id and a.coupon_id = e.coupon_id and a.status = 'VALID') then
      update public.no_show_events set status = 'REVERSED', closed_at = now(), reason = 'Coupon recorded'
      where id = e.id;
      continue;
    end if;
    update public.no_show_events
    set status = 'VERIFIED', verified_at = now(),
        policy_version = (select policy_version from public.meal_services where id = e.meal_service_id)
    where id = e.id;
    perform public.write_audit('NO_SHOW_VERIFIED', 'no_show_event', e.id::text, null, null, 'Coupon round finished');
    perform public.apply_penalty_for(e.id);
    v_verified := v_verified + 1;
  end loop;

  -- An aisle closed without its round finished: those candidates can never be
  -- verified until someone finishes the round. Tell the admins once per wave.
  for e in
    select ev.wave_id, ev.aisle_code, ev.meal_service_id, count(*) as pending
    from public.no_show_events ev
    join public.aisle_waves w on w.id = ev.wave_id
    left join public.coupon_collection_rounds c on c.wave_id = ev.wave_id
    where ev.status = 'PENDING' and w.phase = 'CLOSED' and coalesce(c.status, 'OPEN') <> 'FINISHED'
    group by ev.wave_id, ev.aisle_code, ev.meal_service_id
  loop
    perform public.raise_admin_alert('ROUND_NOT_FINISHED', 'round-not-finished:' || e.wave_id,
      jsonb_build_object('wave_id', e.wave_id, 'aisle', e.aisle_code, 'meal_service_id', e.meal_service_id,
                         'pending', e.pending));
  end loop;

  return jsonb_build_object('no_shows_detected', v_detected, 'no_shows_verified', v_verified);
end $$;

-- The scheduler's single entry point now also processes no-shows.
alter function public.run_due_jobs() rename to run_admission_jobs;

create function public.run_due_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.run_admission_jobs() || public.process_no_shows();
end $$;

-- A coupon recorded late reverses the no-show at once; undoing that entry
-- puts it back to pending (the scheduler verifies it again if still due).
create function public.attendance_updates_no_shows() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.no_show_events;
begin
  if tg_op = 'INSERT' and new.status = 'VALID' then
    for e in
      select * from public.no_show_events
      where meal_service_id = new.meal_service_id and coupon_id = new.coupon_id and status in ('PENDING', 'VERIFIED')
      for update
    loop
      update public.no_show_events
      set status = 'REVERSED', closed_at = now(), reason = 'Coupon recorded by attendant',
          reversed_by_attendance_id = new.id
      where id = e.id;
      if e.status = 'VERIFIED' then
        perform public.recompute_penalties(e.user_id, 'Coupon recorded after the round');
      end if;
    end loop;
  elsif tg_op = 'UPDATE' and old.status = 'VALID' and new.status = 'VOIDED' then
    update public.no_show_events
    set status = 'PENDING', closed_at = null, reason = null, reversed_by_attendance_id = null
    where reversed_by_attendance_id = new.id and status = 'REVERSED';
  end if;
  return null;
end $$;

create trigger attendance_updates_no_shows
  after insert or update of status on public.attendance_records
  for each row execute function public.attendance_updates_no_shows();

-- ---------------------------------------------------------------------------
-- Reduced booking priority: one meal, booked during its booking window
-- ---------------------------------------------------------------------------

create function public.apply_priority_reduction() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_penalty public.penalty_events;
begin
  if new.status <> 'STANDBY' or (tg_op = 'UPDATE' and old.status <> 'CANCELLED') then
    return new;
  end if;
  if public.booking_window(new.meal_service_id) <> 'OPEN' then
    return new;
  end if;
  select * into v_penalty from public.penalty_events
  where user_id = new.user_id and level = 'PRIORITY_REDUCTION'
    and (status = 'ACTIVE' or (status = 'CONSUMED' and consumed_meal_service_id = new.meal_service_id))
  order by applied_at
  limit 1
  for update;
  if v_penalty.id is null then
    return new;
  end if;
  new.priority_tier := 1;
  if v_penalty.status = 'ACTIVE' then
    update public.penalty_events
    set status = 'CONSUMED', consumed_at = now(), consumed_meal_service_id = new.meal_service_id
    where id = v_penalty.id;
  end if;
  return new;
end $$;

create trigger apply_priority_reduction
  before insert or update of status on public.booking_participations
  for each row execute function public.apply_priority_reduction();

-- Before the gate, only normal-priority students are confirmed directly or
-- promoted; after it, invitations reach everyone in queue order.
drop function public.next_standby_locked(uuid);
create function public.next_standby_locked(p_meal_service_id uuid, p_include_reduced boolean default false)
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select bp.id from public.booking_participations bp
  where bp.meal_service_id = p_meal_service_id and bp.status = 'STANDBY'
    and (p_include_reduced or bp.priority_tier = 0)
    and exists (select 1 from public.coupon_claims c
                where c.user_id = bp.user_id and c.coupon_id = bp.coupon_id and c.status = 'APPROVED')
  order by bp.priority_tier, bp.queued_at, bp.queue_tiebreak
  limit 1
  for update of bp
$$;

create or replace function public.issue_offers_for_wave(p_wave_id uuid) returns integer
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
    v_part_id := public.next_standby_locked(w.meal_service_id, true);
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

-- ---------------------------------------------------------------------------
-- Student API: own history and appeals
-- ---------------------------------------------------------------------------

create function public.my_dining_history(p_limit integer default 15) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
begin
  return jsonb_build_object(
    'meals', coalesce((
      select jsonb_agg(x.item order by x.service_start_at desc)
      from (
        select m.service_start_at, jsonb_build_object(
          'meal_service_id', m.id, 'meal_type', m.meal_type, 'service_start_at', m.service_start_at,
          'coupon_number', bp.coupon_number,
          'reduced_priority', bp.priority_tier > 0,
          'outcome', case
            when exists (select 1 from public.attendance_records a
                         where a.meal_service_id = m.id and a.coupon_id = bp.coupon_id and a.status = 'VALID') then 'DINED'
            when ns.status = 'VERIFIED' then 'MISSED'
            when ns.status = 'EXCUSED' then 'EXCUSED'
            when ns.status = 'PENDING' then 'CHECKING'
            when bp.status = 'CANCELLED' then 'CANCELLED'
            when m.state in ('CLOSED', 'CANCELLED') and bp.status in ('STANDBY', 'OFFERED') then 'NO_SEAT'
            when m.state in ('CLOSED', 'CANCELLED') then 'NOT_RECORDED'
            else 'UPCOMING'
          end,
          'no_show', case when ns.id is null or ns.status in ('PENDING', 'REVERSED') then null else jsonb_build_object(
            'id', ns.id, 'status', ns.status, 'commitment', ns.commitment, 'reason', ns.reason,
            'appeal', (select jsonb_build_object('status', ap.status, 'explanation', ap.explanation,
                                                 'decision_reason', ap.decision_reason)
                       from public.no_show_appeals ap where ap.no_show_event_id = ns.id)) end) as item
        from public.booking_participations bp
        join public.meal_services m on m.id = bp.meal_service_id
        left join lateral (
          select * from public.no_show_events e
          where e.meal_service_id = m.id and e.user_id = v_uid
          order by e.detected_at desc limit 1) ns on true
        where bp.user_id = v_uid
        order by m.service_start_at desc
        limit least(greatest(p_limit, 1), 50)
      ) x), '[]'::jsonb),
    'missed_in_window', public.no_show_count(v_uid, now()),
    'window_days', public.policy_int('penalty_window_days'),
    'reduced_priority_pending', exists (select 1 from public.penalty_events
                                        where user_id = v_uid and level = 'PRIORITY_REDUCTION' and status = 'ACTIVE'));
end $$;

create function public.submit_no_show_appeal(p_no_show_id uuid, p_explanation text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  e public.no_show_events;
  v_id uuid;
begin
  if coalesce(btrim(p_explanation), '') = '' or char_length(p_explanation) > 1000 then
    raise exception 'an explanation of 1 to 1000 characters is required' using errcode = '22023';
  end if;
  select * into e from public.no_show_events where id = p_no_show_id and user_id = v_uid;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if e.status <> 'VERIFIED' then
    return jsonb_build_object('status', 'NOT_APPEALABLE', 'no_show_status', e.status);
  end if;
  insert into public.no_show_appeals (no_show_event_id, user_id, explanation)
  values (e.id, v_uid, btrim(p_explanation))
  on conflict (no_show_event_id) do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('status', 'ALREADY_SUBMITTED');
  end if;
  perform public.write_audit('NO_SHOW_APPEAL_SUBMITTED', 'no_show_appeal', v_id::text, null,
    jsonb_build_object('no_show_event_id', e.id, 'coupon_number', e.coupon_number));
  return jsonb_build_object('status', 'SUBMITTED', 'appeal_id', v_id);
end $$;

-- ---------------------------------------------------------------------------
-- Admin API
-- ---------------------------------------------------------------------------

-- Excuse (medical, family, staff mistake...) or uphold, with a mandatory reason.
create function public.decide_no_show(p_no_show_id uuid, p_excuse boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  e public.no_show_events;
  v_lifted integer := 0;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into e from public.no_show_events where id = p_no_show_id for update;
  if not found then
    raise exception 'record not found' using errcode = 'P0002';
  end if;
  if e.status not in ('PENDING', 'VERIFIED') then
    return jsonb_build_object('status', 'ALREADY_CLOSED', 'no_show_status', e.status);
  end if;

  if p_excuse then
    update public.no_show_events
    set status = 'EXCUSED', closed_at = now(), closed_by = v_uid, reason = p_reason
    where id = e.id;
    v_lifted := public.recompute_penalties(e.user_id, 'Excused: ' || p_reason);
    update public.no_show_appeals set status = 'EXCUSED', decided_at = now(), decided_by = v_uid, decision_reason = p_reason
    where no_show_event_id = e.id and status = 'OPEN';
    perform public.enqueue_notification(e.user_id, 'NO_SHOW_EXCUSED', 'no-show-excused:' || e.id,
      jsonb_build_object('message', 'A missed-meal record was excused and no longer counts: ' || p_reason));
  else
    if e.status <> 'VERIFIED' then
      return jsonb_build_object('status', 'NOT_VERIFIED');
    end if;
    update public.no_show_appeals set status = 'UPHELD', decided_at = now(), decided_by = v_uid, decision_reason = p_reason
    where no_show_event_id = e.id and status = 'OPEN';
    perform public.enqueue_notification(e.user_id, 'NO_SHOW_UPHELD', 'no-show-upheld:' || e.id,
      jsonb_build_object('message', 'Your explanation was reviewed; the record stays: ' || p_reason));
  end if;

  perform public.write_audit(case when p_excuse then 'NO_SHOW_EXCUSED' else 'NO_SHOW_UPHELD' end,
    'no_show_event', e.id::text, jsonb_build_object('status', e.status),
    jsonb_build_object('excused', p_excuse, 'penalties_lifted', v_lifted), p_reason);
  return jsonb_build_object('status', case when p_excuse then 'EXCUSED' else 'UPHELD' end, 'penalties_lifted', v_lifted);
end $$;

create function public.admin_no_shows(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return jsonb_build_object(
    'pending', (select count(*) from public.no_show_events where status = 'PENDING'),
    'pending_unfinished_rounds', (
      select count(*) from public.no_show_events e
      left join public.coupon_collection_rounds c on c.wave_id = e.wave_id
      where e.status = 'PENDING' and coalesce(c.status, 'OPEN') <> 'FINISHED'),
    'window_days', public.policy_int('penalty_window_days'),
    'records', coalesce((
      select jsonb_agg(x.item order by x.sort_at desc)
      from (
        select coalesce(e.verified_at, e.detected_at) as sort_at, jsonb_build_object(
          'id', e.id, 'status', e.status, 'commitment', e.commitment, 'coupon_number', e.coupon_number,
          'name', p.full_name, 'user_id', e.user_id, 'aisle', e.aisle_code,
          'meal_type', m.meal_type, 'service_start_at', m.service_start_at,
          'verified_at', e.verified_at, 'closed_at', e.closed_at, 'reason', e.reason,
          'count_in_window', public.no_show_count(e.user_id, now()),
          'penalty', (select jsonb_build_object('level', pe.level, 'status', pe.status)
                      from public.penalty_events pe where pe.no_show_event_id = e.id),
          'appeal', (select jsonb_build_object('id', ap.id, 'status', ap.status, 'explanation', ap.explanation,
                                               'submitted_at', ap.submitted_at, 'decision_reason', ap.decision_reason)
                     from public.no_show_appeals ap where ap.no_show_event_id = e.id)) as item
        from public.no_show_events e
        join public.profiles p on p.id = e.user_id
        join public.meal_services m on m.id = e.meal_service_id
        where e.status <> 'PENDING'
        order by coalesce(e.verified_at, e.detected_at) desc
        limit least(greatest(p_limit, 1), 200)
      ) x), '[]'::jsonb),
    -- 90-day trend, private to admins (spec §9.2).
    'repeat', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', r.full_name, 'coupon_number', r.coupon_number,
                                          'in_window', r.in_window, 'in_90_days', r.in_90) order by r.in_window desc, r.in_90 desc)
      from (
        select e.user_id, p.full_name, max(e.coupon_number) as coupon_number,
               public.no_show_count(e.user_id, now()) as in_window, count(*) as in_90
        from public.no_show_events e
        join public.profiles p on p.id = e.user_id
        join public.meal_services m on m.id = e.meal_service_id
        where e.status = 'VERIFIED' and m.service_start_at > now() - interval '90 days'
        group by e.user_id, p.full_name
        having count(*) >= 2
      ) r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.no_show_events enable row level security;
alter table public.penalty_events enable row level security;
alter table public.no_show_appeals enable row level security;

-- Students see their own records (never pending ones); only admins see others' (spec §9.4, §14).
create policy no_show_events_select on public.no_show_events for select to authenticated
  using ((user_id = auth.uid() and status <> 'PENDING') or public.current_app_role() >= 'ADMIN');
create policy penalty_events_select on public.penalty_events for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');
create policy no_show_appeals_select on public.no_show_appeals for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');

grant select on public.no_show_events, public.penalty_events, public.no_show_appeals to authenticated;

grant execute on function
  public.my_dining_history(integer),
  public.submit_no_show_appeal(uuid, text),
  public.decide_no_show(uuid, boolean, text),
  public.admin_no_shows(integer)
to authenticated;
