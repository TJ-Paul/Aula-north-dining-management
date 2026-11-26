-- Phase 4 — the attendant's table-to-table coupon round and the TWO counters.
--
--   Counter A, physical occupancy (O): occupancy_snapshots. A quick headcount
--     per aisle, no identities. This is what Phase 5 uses to release vacancies.
--   Counter B, verified attendance (D): attendance_records. One row per coupon
--     the attendant actually collected at a table. It lags O until the round
--     is finished, so it never means "absent" on its own (spec §3, I6, I9).
--
-- Every entry carries a client-generated client_entry_id, so a retried tap or
-- an offline phone re-sending its queue can never count a meal twice. Paper
-- or offline entries typed in later keep the time the diner was actually
-- seen (observed_at), separate from when it was typed (recorded_at).

create type public.attendance_source as enum ('LIVE', 'OFFLINE_SYNC', 'PAPER_BACKFILL', 'CORRECTION');
create type public.attendance_exception as enum (
  'WRONG_WAVE',   -- has a booking, but for another aisle or wave
  'NOT_INVITED'   -- no valid booking or invitation for this meal service
);

create function public.append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

-- ---------------------------------------------------------------------------
-- Counter A: occupancy snapshots
-- ---------------------------------------------------------------------------

create table public.occupancy_snapshots (
  id uuid primary key default gen_random_uuid(),
  wave_id uuid not null references public.aisle_waves (id),
  meal_service_id uuid not null references public.meal_services (id),
  aisle_code public.aisle_code not null,
  headcount smallint not null check (headcount between 0 and 30),
  observed_at timestamptz not null default now(),   -- when the count was made
  recorded_at timestamptz not null default now(),
  taken_by uuid not null references public.profiles (id),
  corrects_snapshot_id uuid references public.occupancy_snapshots (id),
  correction_reason text,
  constraint occupancy_snapshots_correction_shape
    check ((corrects_snapshot_id is null) = (correction_reason is null))
);

create index occupancy_snapshots_wave_idx on public.occupancy_snapshots (wave_id, observed_at desc, recorded_at desc);

create trigger occupancy_snapshots_append_only
  before update or delete on public.occupancy_snapshots
  for each row execute function public.append_only();

-- The count to trust for a wave: the most recently observed one that has not
-- itself been corrected.
create function public.latest_snapshot(p_wave_id uuid) returns public.occupancy_snapshots
language sql stable security definer set search_path = public, pg_temp as $$
  select s.* from public.occupancy_snapshots s
  where s.wave_id = p_wave_id
    and not exists (select 1 from public.occupancy_snapshots c where c.corrects_snapshot_id = s.id)
  order by s.observed_at desc, s.recorded_at desc
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Coupon collection rounds (one per wave)
-- ---------------------------------------------------------------------------

create table public.coupon_collection_rounds (
  wave_id uuid primary key references public.aisle_waves (id),
  meal_service_id uuid not null references public.meal_services (id),
  aisle_code public.aisle_code not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'FINISHED')),
  started_at timestamptz not null default now(),
  started_by uuid references public.profiles (id),
  finished_at timestamptz,
  finished_by uuid references public.profiles (id),
  finish_note text,
  entries_at_finish integer,
  exceptions_at_finish integer,
  constraint rounds_finished_shape check ((status = 'FINISHED') = (finished_at is not null))
);

-- ---------------------------------------------------------------------------
-- Counter B: attendance records
-- ---------------------------------------------------------------------------

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  wave_id uuid not null references public.aisle_waves (id),
  aisle_code public.aisle_code not null,
  coupon_id uuid not null references public.coupons (id),
  coupon_number integer not null,
  holder_user_id uuid references public.profiles (id),        -- verified holder at the time, if any
  reservation_id uuid references public.reservations (id),
  reservation_prior_state public.reservation_state,          -- for undo
  exception public.attendance_exception,
  source public.attendance_source not null,
  client_entry_id text not null unique check (char_length(client_entry_id) between 8 and 200),
  recorded_by uuid not null references public.profiles (id),
  recorded_at timestamptz not null default now(),
  observed_at timestamptz,          -- reported time the diner was seen (paper/offline); a claim, not a deadline input
  status text not null default 'VALID' check (status in ('VALID', 'VOIDED')),
  voided_at timestamptz,
  voided_by uuid references public.profiles (id),
  void_reason text,
  exception_resolved_at timestamptz,
  exception_resolved_by uuid references public.profiles (id),
  exception_resolution text,
  constraint attendance_voided_shape check ((status = 'VOIDED') = (voided_at is not null and void_reason is not null))
);

-- I5: at most one counted meal per coupon per meal service.
create unique index attendance_one_meal_per_coupon
  on public.attendance_records (meal_service_id, coupon_id) where status = 'VALID';
create index attendance_wave_idx on public.attendance_records (wave_id, status);
create index attendance_holder_idx on public.attendance_records (holder_user_id);

create function public.attendance_records_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attendance records are never deleted; void them' using errcode = '42501';
  end if;
  if old.status = 'VOIDED' then
    raise exception 'a voided attendance record is final' using errcode = '42501';
  end if;
  -- Only voiding and exception resolution may change a record.
  if (to_jsonb(new) - array['status', 'voided_at', 'voided_by', 'void_reason',
                            'exception_resolved_at', 'exception_resolved_by', 'exception_resolution'])
     <> (to_jsonb(old) - array['status', 'voided_at', 'voided_by', 'void_reason',
                               'exception_resolved_at', 'exception_resolved_by', 'exception_resolution']) then
    raise exception 'attendance records are immutable; void and re-record instead' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger attendance_records_guard
  before update or delete on public.attendance_records
  for each row execute function public.attendance_records_guard();

create function public.attendance_result_json(p_record public.attendance_records) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'status', case when p_record.exception is null then 'RECORDED' else 'RECORDED_WITH_EXCEPTION' end,
    'exception', p_record.exception,
    'record_id', p_record.id,
    'coupon_number', p_record.coupon_number,
    'aisle', p_record.aisle_code,
    'recorded_at', p_record.recorded_at,
    -- Lets the attendant spot-check a borrowed coupon.
    'holder_name', (select full_name from public.profiles where id = p_record.holder_user_id),
    'booking_ref', (select booking_ref from public.reservations where id = p_record.reservation_id))
$$;

-- ---------------------------------------------------------------------------
-- Attendant API
-- ---------------------------------------------------------------------------

-- Type coupon → Enter. Never asks a question back; outcomes:
--   RECORDED, RECORDED_WITH_EXCEPTION (WRONG_WAVE / NOT_INVITED),
--   ALREADY_RECORDED, UNKNOWN_COUPON, WAVE_CLOSED.
create function public.record_coupon(
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
  v_holder uuid;
  v_exception public.attendance_exception;
  v_prior public.reservation_state;
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

  -- Serialises entries for this coupon in this meal service, across all attendants.
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

  select * into v_res from public.reservations
  where meal_service_id = v_wave.meal_service_id and coupon_id = v_coupon.id
  order by created_at desc limit 1
  for update;

  if v_res.id is null then
    v_exception := 'NOT_INVITED';
  elsif v_res.wave_id <> p_wave_id then
    -- Never silently consume a place in the wrong aisle; the booking stays as it is.
    v_exception := 'WRONG_WAVE';
  elsif v_res.state in ('CONFIRMED', 'CANCELLED_PENDING_VACANCY', 'EXPIRED_PENDING_RECONCILIATION') then
    -- Same seat-holding state family, so the hold count is unchanged. A late
    -- cancellation is overridden: they did dine (spec §6.5).
    v_prior := v_res.state;
    update public.reservations set state = 'VERIFIED_DINED', state_reason = 'Coupon collected by attendant'
    where id = v_res.id;
  else
    -- Cancelled before the gate, released or already judged a no-show: the
    -- seat may have gone to someone else. Record the meal, flag it, change
    -- nothing else (Phase 6 reverses a no-show from this evidence).
    v_exception := 'NOT_INVITED';
  end if;

  insert into public.coupon_collection_rounds (wave_id, meal_service_id, aisle_code, started_by)
  values (p_wave_id, v_wave.meal_service_id, v_wave.aisle_code, v_uid)
  on conflict (wave_id) do nothing;

  insert into public.attendance_records (
    meal_service_id, wave_id, aisle_code, coupon_id, coupon_number, holder_user_id,
    reservation_id, reservation_prior_state, exception, source, client_entry_id, recorded_by, observed_at
  )
  values (
    v_wave.meal_service_id, p_wave_id, v_wave.aisle_code, v_coupon.id, p_coupon_number, v_holder,
    v_res.id, v_prior, v_exception, p_source, p_client_entry_id, v_uid,
    case when p_source = 'LIVE' then null else p_observed_at end
  )
  returning * into v_rec;

  return public.attendance_result_json(v_rec);
end $$;

-- Undo a mistaken entry (with a reason). The booking goes back to the state it
-- had before the coupon was typed.
create function public.void_attendance(p_record_id uuid, p_reason text) returns jsonb
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

  update public.attendance_records
  set status = 'VOIDED', voided_at = now(), voided_by = v_uid, void_reason = p_reason
  where id = p_record_id;

  perform public.write_audit('ATTENDANCE_VOIDED', 'attendance_record', p_record_id::text,
    jsonb_build_object('coupon_number', v_rec.coupon_number, 'status', 'VALID'),
    jsonb_build_object('status', 'VOIDED'), p_reason);
  return jsonb_build_object('status', 'VOIDED');
end $$;

-- Fix a mistyped coupon in one step: void the old entry and record the right
-- number. If the new number cannot be recorded, nothing changes.
create function public.correct_attendance(
  p_record_id uuid, p_coupon_number integer, p_reason text, p_client_entry_id text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_rec public.attendance_records;
  v_new jsonb;
begin
  select * into v_rec from public.attendance_records where id = p_record_id;
  if not found then
    raise exception 'attendance record not found' using errcode = 'P0002';
  end if;
  begin
    perform public.void_attendance(p_record_id, 'Corrected to coupon ' || p_coupon_number || ': ' || p_reason);
    v_new := public.record_coupon(v_rec.wave_id, p_coupon_number, p_client_entry_id, 'CORRECTION',
                                  coalesce(v_rec.observed_at, v_rec.recorded_at));
    if v_new ->> 'status' not in ('RECORDED', 'RECORDED_WITH_EXCEPTION') then
      raise exception 'correction rejected' using errcode = 'DC001';
    end if;
  exception when sqlstate 'DC001' then
    return jsonb_build_object('status', 'CORRECTION_REJECTED', 'reason', v_new);
  end;
  return jsonb_build_object('status', 'CORRECTED', 'new_entry', v_new);
end $$;

create function public.resolve_attendance_exception(p_record_id uuid, p_resolution text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_rec public.attendance_records;
begin
  if coalesce(btrim(p_resolution), '') = '' then
    raise exception 'a resolution note is required' using errcode = '22023';
  end if;
  select * into v_rec from public.attendance_records where id = p_record_id for update;
  if not found then
    raise exception 'attendance record not found' using errcode = 'P0002';
  end if;
  if v_rec.exception is null or v_rec.status <> 'VALID' then
    return jsonb_build_object('status', 'NO_OPEN_EXCEPTION');
  end if;
  if v_rec.exception_resolved_at is not null then
    return jsonb_build_object('status', 'ALREADY_RESOLVED');
  end if;
  update public.attendance_records
  set exception_resolved_at = now(), exception_resolved_by = v_uid, exception_resolution = p_resolution
  where id = p_record_id;
  perform public.write_audit('ATTENDANCE_EXCEPTION_RESOLVED', 'attendance_record', p_record_id::text,
    jsonb_build_object('exception', v_rec.exception), null, p_resolution);
  return jsonb_build_object('status', 'RESOLVED');
end $$;

-- "I have visited every diner in this aisle." Only after this may Phase 6
-- turn missing coupons into no-shows.
create function public.finish_collection_round(
  p_wave_id uuid, p_confirm_visited_all boolean, p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_wave public.aisle_waves;
  v_round public.coupon_collection_rounds;
  v_entries integer;
  v_exceptions integer;
begin
  select * into v_wave from public.aisle_waves where id = p_wave_id for share;
  if not found then
    raise exception 'wave not found' using errcode = 'P0002';
  end if;
  if v_wave.phase = 'BOOKING' then
    return jsonb_build_object('status', 'GATE_NOT_OPEN');
  end if;
  if not coalesce(p_confirm_visited_all, false) then
    return jsonb_build_object('status', 'ATTESTATION_REQUIRED');
  end if;

  insert into public.coupon_collection_rounds (wave_id, meal_service_id, aisle_code, started_by)
  values (p_wave_id, v_wave.meal_service_id, v_wave.aisle_code, v_uid)
  on conflict (wave_id) do nothing;
  select * into v_round from public.coupon_collection_rounds where wave_id = p_wave_id for update;
  if v_round.status = 'FINISHED' then
    return jsonb_build_object('status', 'ALREADY_FINISHED', 'finished_at', v_round.finished_at);
  end if;

  select count(*), count(*) filter (where exception is not null)
  into v_entries, v_exceptions
  from public.attendance_records where wave_id = p_wave_id and status = 'VALID';

  update public.coupon_collection_rounds
  set status = 'FINISHED', finished_at = now(), finished_by = v_uid, finish_note = p_note,
      entries_at_finish = v_entries, exceptions_at_finish = v_exceptions
  where wave_id = p_wave_id;

  perform public.write_audit('COLLECTION_ROUND_FINISHED', 'aisle_wave', p_wave_id::text, null,
    jsonb_build_object('entries', v_entries, 'exceptions', v_exceptions), p_note);
  return jsonb_build_object('status', 'FINISHED', 'entries', v_entries, 'exceptions', v_exceptions);
end $$;

create function public.reopen_collection_round(p_wave_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_round public.coupon_collection_rounds;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_round from public.coupon_collection_rounds where wave_id = p_wave_id for update;
  if not found or v_round.status = 'OPEN' then
    return jsonb_build_object('status', 'NOT_FINISHED');
  end if;
  update public.coupon_collection_rounds
  set status = 'OPEN', finished_at = null, finished_by = null, finish_note = null,
      entries_at_finish = null, exceptions_at_finish = null
  where wave_id = p_wave_id;
  perform public.write_audit('COLLECTION_ROUND_REOPENED', 'aisle_wave', p_wave_id::text,
    to_jsonb(v_round), jsonb_build_object('status', 'OPEN'), p_reason);
  return jsonb_build_object('status', 'REOPENED');
end $$;

-- Quick physical headcount of one aisle: people, not names.
create function public.record_occupancy_snapshot(
  p_wave_id uuid, p_headcount smallint, p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_action text := 'record_occupancy_snapshot:' || p_wave_id;
  v_prior jsonb;
  v_wave public.aisle_waves;
  v_snap public.occupancy_snapshots;
  v_result jsonb;
begin
  v_prior := public.idem_lookup(p_idempotency_key, v_action);
  if v_prior is not null then
    return v_prior;
  end if;
  select * into v_wave from public.aisle_waves where id = p_wave_id for share;
  if not found then
    raise exception 'wave not found' using errcode = 'P0002';
  end if;
  if v_wave.phase = 'CLOSED' then
    return jsonb_build_object('status', 'WAVE_CLOSED');
  end if;
  if v_wave.phase = 'BOOKING' then
    return jsonb_build_object('status', 'GATE_NOT_OPEN');
  end if;

  insert into public.occupancy_snapshots (wave_id, meal_service_id, aisle_code, headcount, taken_by)
  values (p_wave_id, v_wave.meal_service_id, v_wave.aisle_code, p_headcount, v_uid)
  returning * into v_snap;

  if p_headcount > v_wave.capacity then
    -- More people than usable seats: someone sat without a place.
    perform public.raise_admin_alert('OCCUPANCY_OVER_CAPACITY', 'over-capacity:' || v_snap.id,
      jsonb_build_object('wave_id', p_wave_id, 'aisle', v_wave.aisle_code,
                         'headcount', p_headcount, 'capacity', v_wave.capacity));
  end if;

  perform public.write_audit('OCCUPANCY_SNAPSHOT', 'aisle_wave', p_wave_id::text, null,
    jsonb_build_object('snapshot_id', v_snap.id, 'headcount', p_headcount));

  v_result := jsonb_build_object('status', 'RECORDED', 'snapshot_id', v_snap.id, 'headcount', p_headcount,
                                 'physically_vacant', greatest(0, v_wave.capacity - p_headcount));
  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

-- A miscounted headcount is corrected by a new row; the old one is kept.
create function public.correct_occupancy_snapshot(
  p_snapshot_id uuid, p_headcount smallint, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_old public.occupancy_snapshots;
  v_snap public.occupancy_snapshots;
begin
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  select * into v_old from public.occupancy_snapshots where id = p_snapshot_id;
  if not found then
    raise exception 'snapshot not found' using errcode = 'P0002';
  end if;
  perform 1 from public.aisle_waves where id = v_old.wave_id for share;
  if exists (select 1 from public.occupancy_snapshots where corrects_snapshot_id = p_snapshot_id) then
    return jsonb_build_object('status', 'ALREADY_CORRECTED');
  end if;

  insert into public.occupancy_snapshots (
    wave_id, meal_service_id, aisle_code, headcount, observed_at, taken_by, corrects_snapshot_id, correction_reason)
  values (v_old.wave_id, v_old.meal_service_id, v_old.aisle_code, p_headcount, v_old.observed_at, v_uid,
          p_snapshot_id, p_reason)
  returning * into v_snap;

  perform public.write_audit('OCCUPANCY_SNAPSHOT_CORRECTED', 'occupancy_snapshot', p_snapshot_id::text,
    jsonb_build_object('headcount', v_old.headcount), jsonb_build_object('headcount', p_headcount,
    'snapshot_id', v_snap.id), p_reason);
  return jsonb_build_object('status', 'CORRECTED', 'snapshot_id', v_snap.id);
end $$;

-- The attendant's sticky status cards: one per aisle, the counters kept apart.
create function public.attendant_board(p_meal_service_id uuid) returns jsonb
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
        'round', coalesce((select r.status from public.coupon_collection_rounds r where r.wave_id = w.id), 'NOT_STARTED')
      ) as card
      from public.aisles a
      join public.aisle_status st on st.aisle_code = a.code
      left join public.aisle_waves w on w.id = a.current_wave_id and w.meal_service_id = p_meal_service_id
      left join lateral (select * from public.latest_snapshot(w.id)) s on true
    ) cards
  ), '[]'::jsonb);
end $$;

-- Meal services around now, for the app to pick from. No personal data.
create function public.active_meal_services() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'service_date', service_date, 'meal_type', meal_type,
           'service_start_at', service_start_at, 'state', state)
         order by service_start_at), '[]'::jsonb)
  from public.meal_services
  where state in ('SCHEDULED', 'IN_SERVICE')
    and service_start_at between now() - interval '18 hours' and now() + interval '18 hours'
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.occupancy_snapshots enable row level security;
alter table public.coupon_collection_rounds enable row level security;
alter table public.attendance_records enable row level security;

create policy occupancy_snapshots_select on public.occupancy_snapshots for select to authenticated
  using (public.current_app_role() >= 'ATTENDANT');
create policy rounds_select on public.coupon_collection_rounds for select to authenticated
  using (public.current_app_role() >= 'ATTENDANT');
-- Students see their own dining history; staff see all.
create policy attendance_select on public.attendance_records for select to authenticated
  using (holder_user_id = auth.uid() or public.current_app_role() >= 'ATTENDANT');

grant select on public.occupancy_snapshots, public.coupon_collection_rounds, public.attendance_records
  to authenticated;

grant execute on function
  public.record_coupon(uuid, integer, text, public.attendance_source, timestamptz),
  public.void_attendance(uuid, text),
  public.correct_attendance(uuid, integer, text, text),
  public.resolve_attendance_exception(uuid, text),
  public.finish_collection_round(uuid, boolean, text),
  public.reopen_collection_round(uuid, text),
  public.record_occupancy_snapshot(uuid, smallint, text),
  public.correct_occupancy_snapshot(uuid, smallint, text),
  public.attendant_board(uuid),
  public.active_meal_services()
to authenticated;
