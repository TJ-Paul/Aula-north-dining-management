-- Phase 2 — meal services, the two physical aisles, aisle waves and the
-- whole-aisle turnover lifecycle.
--
-- Aisle lifecycle (spec §2 I1–I3, I10; §8):
--
--   RESTORING --mark_aisle_ready(empty, cleaned, food restored)--> READY
--   READY     --open_aisle_wave-------------------------------->  IN_WAVE
--   IN_WAVE   --close_aisle_wave(all diners left)-------------->  RESTORING
--
-- Wave phases move forward only:
--   BOOKING -> ADMITTING -> DINING -> WAITING_FOR_ALL_TO_FINISH -> CLOSED
--
-- Capacity exists only as the capacity of an open wave, and a wave can only
-- be opened from READY, which it consumes. Pressing "ready" twice, or
-- "open" twice, can therefore never create a second 30 seats for one aisle.
-- Individual diners leaving never free seats: only closing the whole wave
-- does, and that leads to RESTORING, never straight to READY.

create type public.aisle_code as enum ('A', 'B');
create type public.aisle_readiness as enum ('RESTORING', 'READY', 'IN_WAVE');
create type public.wave_phase as enum ('BOOKING', 'ADMITTING', 'DINING', 'WAITING_FOR_ALL_TO_FINISH', 'CLOSED');
create type public.meal_type as enum ('BREAKFAST', 'LUNCH', 'DINNER');
create type public.meal_service_state as enum ('SCHEDULED', 'IN_SERVICE', 'CLOSED', 'CANCELLED');

-- ---------------------------------------------------------------------------
-- Meal services
-- ---------------------------------------------------------------------------

create table public.meal_services (
  id uuid primary key default gen_random_uuid(),
  service_date date not null,
  meal_type public.meal_type not null,
  timezone text not null default 'Asia/Dhaka',
  service_start_at timestamptz not null,       -- T: gate opens for confirmed diners
  state public.meal_service_state not null default 'SCHEDULED',
  policy_version integer not null references public.policy_settings (version),
  -- Emergency "pause invitations" control (spec §13.10); used from Phase 5.
  invitations_paused boolean not null default false,
  invitations_paused_reason text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  unique (service_date, meal_type)
);

-- ---------------------------------------------------------------------------
-- Aisles: exactly A and B, 30 physical seats each
-- ---------------------------------------------------------------------------

create table public.aisles (
  code public.aisle_code primary key,
  physical_capacity smallint not null default 30 check (physical_capacity = 30),
  unusable_seats smallint not null default 0 check (unusable_seats between 0 and 30),
  readiness public.aisle_readiness not null default 'RESTORING',
  current_wave_id uuid,
  ready_confirmed_by uuid references public.profiles (id),
  ready_confirmed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint aisles_wave_iff_in_wave check ((readiness = 'IN_WAVE') = (current_wave_id is not null))
);

insert into public.aisles (code) values ('A'), ('B');

-- ---------------------------------------------------------------------------
-- Aisle waves
-- ---------------------------------------------------------------------------

create table public.aisle_waves (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  aisle_code public.aisle_code not null references public.aisles (code),
  wave_number integer not null check (wave_number >= 1),
  -- Usable seats when the wave opened. May only go down afterwards.
  capacity smallint not null check (capacity between 0 and 30),
  phase public.wave_phase not null default 'BOOKING',
  ready_confirmed_by uuid references public.profiles (id),
  ready_confirmed_at timestamptz,
  opened_by uuid references public.profiles (id),
  opened_at timestamptz not null default now(),
  admitting_at timestamptz,
  dining_at timestamptz,
  finishing_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references public.profiles (id),
  close_note text,
  unique (meal_service_id, aisle_code, wave_number),
  constraint aisle_waves_closed_shape check ((phase = 'CLOSED') = (closed_at is not null))
);

-- One physical aisle hosts at most one live wave at a time, across all meal services.
create unique index aisle_waves_one_live_per_aisle on public.aisle_waves (aisle_code) where phase <> 'CLOSED';
create index aisle_waves_meal_service_idx on public.aisle_waves (meal_service_id);

alter table public.aisles
  add constraint aisles_current_wave_fk foreign key (current_wave_id) references public.aisle_waves (id);

create function public.aisles_guard() returns trigger
language plpgsql as $$
declare
  v_wave public.aisle_waves;
begin
  if tg_op = 'DELETE' then
    raise exception 'aisles cannot be deleted' using errcode = '42501';
  end if;
  if new.code <> old.code then
    raise exception 'aisle code is immutable' using errcode = '42501';
  end if;
  if new.current_wave_id is not null and new.current_wave_id is distinct from old.current_wave_id then
    select * into v_wave from public.aisle_waves where id = new.current_wave_id;
    if v_wave.aisle_code <> new.code or v_wave.phase = 'CLOSED' then
      raise exception 'current wave must be a live wave of this aisle' using errcode = '23514';
    end if;
  end if;
  -- READY may only be entered from RESTORING, by a named person.
  if new.readiness = 'READY' and old.readiness <> 'READY' then
    if old.readiness <> 'RESTORING' or new.ready_confirmed_by is null then
      raise exception 'an aisle becomes READY only from RESTORING with a human confirmation'
        using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger aisles_guard
  before update or delete on public.aisles
  for each row execute function public.aisles_guard();

create function public.aisle_waves_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'aisle waves cannot be deleted' using errcode = '42501';
  end if;
  if old.phase = 'CLOSED' then
    raise exception 'a closed wave is immutable' using errcode = '42501';
  end if;
  if new.meal_service_id <> old.meal_service_id or new.aisle_code <> old.aisle_code
     or new.wave_number <> old.wave_number or new.opened_at <> old.opened_at then
    raise exception 'wave identity columns are immutable' using errcode = '42501';
  end if;
  if new.capacity > old.capacity then
    raise exception 'wave capacity can never be increased' using errcode = '23514';
  end if;
  if new.phase < old.phase then
    raise exception 'wave phase cannot move backwards (% -> %)', old.phase, new.phase using errcode = '23514';
  end if;
  if new.phase = 'CLOSED' and exists (
    select 1 from public.aisles where code = new.aisle_code and current_wave_id = new.id
  ) then
    raise exception 'release the aisle before closing its wave' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger aisle_waves_guard
  before update or delete on public.aisle_waves
  for each row execute function public.aisle_waves_guard();

-- ---------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------

-- Per-aisle public status (spec §10). No personal data.
create view public.aisle_status with (security_invoker = true) as
select
  a.code as aisle_code,
  a.physical_capacity,
  a.physical_capacity - a.unusable_seats as usable_capacity,
  a.readiness,
  case
    when a.readiness <> 'IN_WAVE' then a.readiness::text
    when w.phase = 'BOOKING' then 'READY'
    else w.phase::text
  end as display_state,
  w.id as wave_id,
  w.meal_service_id,
  w.wave_number,
  w.capacity as wave_capacity,
  w.phase as wave_phase,
  a.ready_confirmed_at
from public.aisles a
left join public.aisle_waves w on w.id = a.current_wave_id;

-- Bookable capacity of a meal service = sum of its live waves (0, 30 or 60
-- before unusable-seat adjustments).
create view public.meal_service_capacity with (security_invoker = true) as
select
  ms.id as meal_service_id,
  coalesce(sum(w.capacity) filter (where w.phase <> 'CLOSED'), 0)::integer as live_wave_capacity,
  count(w.id) filter (where w.phase <> 'CLOSED')::integer as live_waves
from public.meal_services ms
left join public.aisle_waves w on w.meal_service_id = ms.id
group by ms.id;

-- ---------------------------------------------------------------------------
-- Meal service operations
-- ---------------------------------------------------------------------------

create function public.create_meal_service(
  p_service_date date, p_meal_type public.meal_type, p_service_start_at timestamptz
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_service public.meal_services;
begin
  insert into public.meal_services (service_date, meal_type, service_start_at, policy_version, created_by)
  values (p_service_date, p_meal_type, p_service_start_at,
          (select version from public.policy_settings where is_active), v_uid)
  on conflict (service_date, meal_type) do nothing
  returning * into v_service;

  if not found then
    select * into v_service from public.meal_services
    where service_date = p_service_date and meal_type = p_meal_type;
    return jsonb_build_object('status', 'EXISTS', 'meal_service_id', v_service.id);
  end if;

  perform public.write_audit('MEAL_SERVICE_CREATED', 'meal_service', v_service.id::text, null, to_jsonb(v_service));
  return jsonb_build_object('status', 'CREATED', 'meal_service_id', v_service.id);
end $$;

create function public.set_meal_service_state(
  p_meal_service_id uuid, p_target public.meal_service_state, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_service public.meal_services;
begin
  select * into v_service from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;
  if v_service.state = p_target then
    return jsonb_build_object('status', 'UNCHANGED');
  end if;
  if not (
    (v_service.state = 'SCHEDULED' and p_target in ('IN_SERVICE', 'CANCELLED'))
    or (v_service.state = 'IN_SERVICE' and p_target = 'CLOSED')
  ) then
    return jsonb_build_object('status', 'INVALID_TRANSITION', 'from', v_service.state, 'to', p_target);
  end if;
  if p_target in ('CLOSED', 'CANCELLED') and exists (
    select 1 from public.aisle_waves where meal_service_id = p_meal_service_id and phase <> 'CLOSED'
  ) then
    return jsonb_build_object('status', 'LIVE_WAVES_REMAIN');
  end if;
  update public.meal_services set state = p_target, state_changed_at = now() where id = p_meal_service_id;
  perform public.write_audit('MEAL_SERVICE_STATE_CHANGED', 'meal_service', p_meal_service_id::text,
    jsonb_build_object('state', v_service.state), jsonb_build_object('state', p_target), p_reason);
  return jsonb_build_object('status', 'OK', 'state', p_target);
end $$;

-- ---------------------------------------------------------------------------
-- Aisle and wave operations (attendant or higher)
-- ---------------------------------------------------------------------------

-- Caller must hold the aisle row lock and have checked authorization.
create function public.open_aisle_wave_locked(
  p_aisle public.aisle_code, p_meal_service_id uuid, p_actor uuid
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_aisle public.aisles;
  v_service public.meal_services;
  v_wave public.aisle_waves;
  v_capacity smallint;
begin
  select * into v_aisle from public.aisles where code = p_aisle for update;
  if v_aisle.readiness <> 'READY' then
    return jsonb_build_object('status', 'AISLE_NOT_READY', 'readiness', v_aisle.readiness,
                              'wave_id', v_aisle.current_wave_id);
  end if;

  select * into v_service from public.meal_services where id = p_meal_service_id for share;
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

  return jsonb_build_object('status', 'WAVE_OPENED', 'wave_id', v_wave.id,
                            'wave_number', v_wave.wave_number, 'capacity', v_wave.capacity);
end $$;

-- "Food restored / aisle ready". Requires the attendant to attest that the
-- aisle is physically empty, cleaned and restocked. Optionally opens the
-- next wave for a meal service in the same transaction (spec §4.3).
create function public.mark_aisle_ready(
  p_aisle public.aisle_code,
  p_confirm_empty boolean,
  p_confirm_cleaned boolean,
  p_confirm_food_restored boolean,
  p_open_wave_for_meal_service uuid default null,
  p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_action text := 'mark_aisle_ready:' || p_aisle;
  v_prior jsonb;
  v_aisle public.aisles;
  v_result jsonb;
  v_wave jsonb;
begin
  v_prior := public.idem_lookup(p_idempotency_key, v_action);
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_aisle from public.aisles where code = p_aisle for update;

  if v_aisle.readiness = 'IN_WAVE' then
    return jsonb_build_object('status', 'AISLE_IN_USE', 'wave_id', v_aisle.current_wave_id);
  elsif v_aisle.readiness = 'READY' then
    v_result := jsonb_build_object('status', 'ALREADY_READY');
  else
    if not (coalesce(p_confirm_empty, false) and coalesce(p_confirm_cleaned, false)
            and coalesce(p_confirm_food_restored, false)) then
      return jsonb_build_object('status', 'ATTESTATION_REQUIRED');
    end if;
    update public.aisles
    set readiness = 'READY', ready_confirmed_by = v_uid, ready_confirmed_at = now()
    where code = p_aisle;
    perform public.write_audit('AISLE_MARKED_READY', 'aisle', p_aisle::text,
      jsonb_build_object('readiness', v_aisle.readiness),
      jsonb_build_object('readiness', 'READY', 'empty', true, 'cleaned', true, 'food_restored', true));
    v_result := jsonb_build_object('status', 'READY');
  end if;

  if p_open_wave_for_meal_service is not null then
    v_wave := public.open_aisle_wave_locked(p_aisle, p_open_wave_for_meal_service, v_uid);
    v_result := v_result || jsonb_build_object('wave', v_wave);
    if v_wave ->> 'status' <> 'WAVE_OPENED' then
      return v_result;  -- not stored: a retry should re-evaluate
    end if;
  end if;

  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

create function public.open_aisle_wave(
  p_meal_service_id uuid, p_aisle public.aisle_code, p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_action text := 'open_aisle_wave:' || p_aisle || ':' || p_meal_service_id;
  v_prior jsonb;
  v_result jsonb;
begin
  v_prior := public.idem_lookup(p_idempotency_key, v_action);
  if v_prior is not null then
    return v_prior;
  end if;
  v_result := public.open_aisle_wave_locked(p_aisle, p_meal_service_id, v_uid);
  if v_result ->> 'status' = 'WAVE_OPENED' then
    perform public.idem_store(p_idempotency_key, v_action, v_result);
  end if;
  return v_result;
end $$;

create function public.advance_wave_phase(p_wave_id uuid, p_target public.wave_phase) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_wave public.aisle_waves;
begin
  if p_target not in ('ADMITTING', 'DINING', 'WAITING_FOR_ALL_TO_FINISH') then
    raise exception 'use close_aisle_wave to close a wave' using errcode = '22023';
  end if;
  select * into v_wave from public.aisle_waves where id = p_wave_id for update;
  if not found then
    raise exception 'wave not found' using errcode = 'P0002';
  end if;
  if v_wave.phase = 'CLOSED' then
    return jsonb_build_object('status', 'WAVE_CLOSED');
  end if;
  if v_wave.phase = p_target then
    return jsonb_build_object('status', 'UNCHANGED', 'phase', p_target);
  end if;
  if p_target < v_wave.phase then
    return jsonb_build_object('status', 'INVALID_TRANSITION', 'from', v_wave.phase, 'to', p_target);
  end if;
  update public.aisle_waves
  set phase = p_target,
      admitting_at = case when p_target >= 'ADMITTING' then coalesce(admitting_at, now()) else admitting_at end,
      dining_at = case when p_target >= 'DINING' then coalesce(dining_at, now()) else dining_at end,
      finishing_at = case when p_target >= 'WAITING_FOR_ALL_TO_FINISH' then coalesce(finishing_at, now()) else finishing_at end
  where id = p_wave_id;
  perform public.write_audit('AISLE_WAVE_PHASE_CHANGED', 'aisle_wave', p_wave_id::text,
    jsonb_build_object('phase', v_wave.phase), jsonb_build_object('phase', p_target));
  return jsonb_build_object('status', 'OK', 'phase', p_target);
end $$;

-- "All diners left". Ends the wave and sends the aisle to RESTORING. Works
-- for an underfilled aisle too: what matters is that everyone who actually
-- sat down has gone, not how many ate (spec Case 5).
create function public.close_aisle_wave(
  p_wave_id uuid, p_confirm_all_diners_left boolean, p_note text default null,
  p_idempotency_key text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ATTENDANT');
  v_action text := 'close_aisle_wave:' || p_wave_id;
  v_prior jsonb;
  v_wave public.aisle_waves;
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
  -- Lock order everywhere: aisle, then wave.
  perform 1 from public.aisles where code = v_wave.aisle_code for update;
  select * into v_wave from public.aisle_waves where id = p_wave_id for update;

  if v_wave.phase = 'CLOSED' then
    return jsonb_build_object('status', 'ALREADY_CLOSED');
  end if;
  if not coalesce(p_confirm_all_diners_left, false) then
    return jsonb_build_object('status', 'ATTESTATION_REQUIRED');
  end if;

  -- Later phases add: unresolved seat holds on this wave are moved to
  -- reconciliation before the wave may close.

  update public.aisles set readiness = 'RESTORING', current_wave_id = null
  where code = v_wave.aisle_code and current_wave_id = p_wave_id;

  update public.aisle_waves
  set phase = 'CLOSED', closed_at = now(), closed_by = v_uid, close_note = p_note
  where id = p_wave_id;

  perform public.write_audit('AISLE_WAVE_CLOSED', 'aisle_wave', p_wave_id::text,
    jsonb_build_object('phase', v_wave.phase), jsonb_build_object('phase', 'CLOSED', 'all_diners_left', true), p_note);

  v_result := jsonb_build_object('status', 'CLOSED', 'aisle_readiness', 'RESTORING');
  return public.idem_store(p_idempotency_key, v_action, v_result);
end $$;

-- Mark seats genuinely unusable (broken chair, spill). Lowering takes effect
-- on the live wave immediately; raising only applies to the next wave, so
-- capacity is never created mid-wave.
create function public.set_aisle_unusable_seats(
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
  update public.aisles set unusable_seats = p_unusable_seats where code = p_aisle;
  v_new_usable := v_aisle.physical_capacity - p_unusable_seats;

  if v_aisle.current_wave_id is not null then
    select * into v_wave from public.aisle_waves where id = v_aisle.current_wave_id for update;
    -- Later phases add: refuse to go below the wave's active seat holds.
    if v_new_usable < v_wave.capacity then
      update public.aisle_waves set capacity = v_new_usable where id = v_wave.id;
    end if;
  end if;

  perform public.write_audit('AISLE_UNUSABLE_SEATS_CHANGED', 'aisle', p_aisle::text,
    jsonb_build_object('unusable_seats', v_aisle.unusable_seats, 'wave_capacity', v_wave.capacity),
    jsonb_build_object('unusable_seats', p_unusable_seats,
                       'wave_capacity', least(v_wave.capacity, v_new_usable)),
    p_reason);
  return jsonb_build_object('status', 'OK', 'usable_capacity', v_new_usable,
                            'wave_capacity', least(v_wave.capacity, v_new_usable));
end $$;

-- ---------------------------------------------------------------------------
-- Row level security: these tables hold no personal data and are readable
-- by any signed-in user; all writes go through the functions above.
-- ---------------------------------------------------------------------------

alter table public.meal_services enable row level security;
alter table public.aisles enable row level security;
alter table public.aisle_waves enable row level security;

create policy meal_services_select on public.meal_services for select to authenticated using (true);
create policy aisles_select on public.aisles for select to authenticated using (true);
create policy aisle_waves_select on public.aisle_waves for select to authenticated using (true);

grant select on public.meal_services, public.aisles, public.aisle_waves,
  public.aisle_status, public.meal_service_capacity to authenticated;

grant execute on function
  public.create_meal_service(date, public.meal_type, timestamptz),
  public.set_meal_service_state(uuid, public.meal_service_state, text),
  public.mark_aisle_ready(public.aisle_code, boolean, boolean, boolean, uuid, text),
  public.open_aisle_wave(uuid, public.aisle_code, text),
  public.advance_wave_phase(uuid, public.wave_phase),
  public.close_aisle_wave(uuid, boolean, text, text),
  public.set_aisle_unusable_seats(public.aisle_code, smallint, text)
to authenticated;
