-- "Not coming" notices, reward points and treats.
--
-- No answer means coming. A verified student may say "not coming" until the
-- meal's notice deadline (by default 4 hours before it starts, when cooking
-- begins; admins can move it per meal). They can take it back on their own for
-- 8 hours (and only before the deadline); after that an admin must approve.
--
-- After the meal: kept their word -> a reward point, up to a small cap. Said
-- "not coming" but their coupon was recorded (or an admin saw them) -> a mild
-- penalty. Points are redeemed as treats an admin hands out at a later meal.

-- ---------------------------------------------------------------------------
-- Settings (one row, editable by admins)
-- ---------------------------------------------------------------------------

create table public.rsvp_settings (
  id boolean primary key default true check (id),
  default_lead_minutes integer not null default 240 check (default_lead_minutes between 0 and 2880),
  change_window_minutes integer not null default 480 check (change_window_minutes between 0 and 2880),
  reward_points integer not null default 1 check (reward_points between 0 and 10),
  penalty_points integer not null default 2 check (penalty_points between 0 and 10),
  max_points integer not null default 3 check (max_points between 1 and 20),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
insert into public.rsvp_settings default values;

create function public.rsvp_config() returns public.rsvp_settings
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.rsvp_settings
$$;

-- Per-meal notice period; null = the default.
alter table public.meal_services
  add column rsvp_lead_minutes integer check (rsvp_lead_minutes between 0 and 10080),
  add column rsvp_settled_at timestamptz;

create function public.rsvp_deadline(p_ms public.meal_services) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select p_ms.service_start_at
         - make_interval(mins => coalesce(p_ms.rsvp_lead_minutes, (public.rsvp_config()).default_lead_minutes))
$$;

create function public.coupon_number_of(p_user_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select k.coupon_number from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
  where c.user_id = p_user_id and c.status = 'APPROVED'
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.meal_rsvps (
  meal_service_id uuid not null references public.meal_services (id),
  user_id uuid not null references public.profiles (id),
  status text not null check (status in ('NOT_COMING', 'WITHDRAWN')),
  set_at timestamptz not null default now(),
  changed_at timestamptz,
  outcome text check (outcome in ('REWARDED', 'CAME_ANYWAY')),
  points_awarded integer not null default 0,   -- reward given (0 at the cap)
  penalty_applied integer not null default 0,  -- penalty taken
  came_attendance_id uuid references public.attendance_records (id),  -- null when an admin marked it
  settled_at timestamptz,
  primary key (meal_service_id, user_id)
);

create table public.rsvp_change_requests (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null,
  user_id uuid not null,
  reason text check (char_length(reason) <= 300),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  admin_note text check (char_length(admin_note) <= 300),
  foreign key (meal_service_id, user_id) references public.meal_rsvps (meal_service_id, user_id)
);
create unique index rsvp_change_requests_one_pending on public.rsvp_change_requests (meal_service_id, user_id)
  where status = 'PENDING';

create table public.points_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  meal_service_id uuid references public.meal_services (id),
  kind text not null check (kind in ('REWARD', 'PENALTY', 'REVERSAL', 'TREAT')),
  points integer not null check (points <> 0),
  note text check (char_length(note) <= 300),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index points_ledger_user on public.points_ledger (user_id, created_at);

create function public.points_ledger_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'points_ledger is append-only' using errcode = '42501';
end $$;
create trigger points_ledger_append_only before update or delete on public.points_ledger
  for each row execute function public.points_ledger_append_only();

create function public.points_balance(p_user_id uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(points), 0)::integer from public.points_ledger where user_id = p_user_id
$$;

-- Booking a meal you said you'd skip: take the notice back first.
create function public.booking_respects_not_coming() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status <> 'CANCELLED' and (tg_op = 'INSERT' or old.status = 'CANCELLED')
     and exists (select 1 from public.meal_rsvps
                 where meal_service_id = new.meal_service_id and user_id = new.user_id and status = 'NOT_COMING') then
    raise exception 'You said you are not coming to this meal. Take that back before booking.' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger booking_respects_not_coming before insert or update of status on public.booking_participations
  for each row execute function public.booking_respects_not_coming();

-- ---------------------------------------------------------------------------
-- Outcomes (internal)
-- ---------------------------------------------------------------------------

create function public.meal_label(p_ms public.meal_services) returns text
language sql stable as $$
  select coalesce(p_ms.name, initcap(lower(p_ms.meal_type::text))) || ' on ' || to_char(p_ms.service_date, 'DD Mon')
$$;

-- Kept their word: a reward point, never above the cap.
create function public.rsvp_reward(p_meal_service_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg public.rsvp_settings := public.rsvp_config();
  v_ms public.meal_services;
  v_pts integer;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  v_pts := greatest(0, least(v_cfg.reward_points, v_cfg.max_points - public.points_balance(p_user_id)));
  if v_pts > 0 then
    insert into public.points_ledger (user_id, meal_service_id, kind, points, note)
    values (p_user_id, p_meal_service_id, 'REWARD', v_pts, 'Said "not coming" and kept to it');
  end if;
  update public.meal_rsvps set outcome = 'REWARDED', points_awarded = v_pts, settled_at = now()
  where meal_service_id = p_meal_service_id and user_id = p_user_id;
  perform public.enqueue_notification(p_user_id, 'REWARD_POINTS', 'rsvp-reward:' || p_meal_service_id || ':' || p_user_id,
    jsonb_build_object('message', case when v_pts > 0
      then 'Thanks for telling us you would skip ' || public.meal_label(v_ms) || '. +' || v_pts
           || ' reward point' || case when v_pts = 1 then '' else 's' end || ' for a treat later.'
      else 'Thanks for telling us you would skip ' || public.meal_label(v_ms) || '. You already have the most reward points ('
           || v_cfg.max_points || '); ask for your treat at a meal.' end));
end $$;

-- Said "not coming" but ate: undo any reward, then a mild penalty (balance never below -max).
create function public.rsvp_came_anyway(p_meal_service_id uuid, p_user_id uuid, p_attendance_id uuid, p_note text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_cfg public.rsvp_settings := public.rsvp_config();
  v_r public.meal_rsvps;
  v_ms public.meal_services;
  v_pen integer;
begin
  select * into v_r from public.meal_rsvps where meal_service_id = p_meal_service_id and user_id = p_user_id for update;
  if v_r.outcome = 'CAME_ANYWAY' then
    return;
  end if;
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if v_r.points_awarded > 0 then
    insert into public.points_ledger (user_id, meal_service_id, kind, points, note)
    values (p_user_id, p_meal_service_id, 'REVERSAL', -v_r.points_awarded, 'Reward taken back: came after all');
  end if;
  v_pen := greatest(0, least(v_cfg.penalty_points, public.points_balance(p_user_id) + v_cfg.max_points));
  if v_pen > 0 then
    insert into public.points_ledger (user_id, meal_service_id, kind, points, note, created_by)
    values (p_user_id, p_meal_service_id, 'PENALTY', -v_pen,
            coalesce(p_note, 'Said "not coming" but came'), case when p_attendance_id is null then auth.uid() end);
  end if;
  update public.meal_rsvps
  set outcome = 'CAME_ANYWAY', points_awarded = 0, penalty_applied = v_pen, came_attendance_id = p_attendance_id,
      settled_at = coalesce(settled_at, now())
  where meal_service_id = p_meal_service_id and user_id = p_user_id;
  perform public.enqueue_notification(p_user_id, 'CAME_ANYWAY', 'rsvp-came:' || p_meal_service_id || ':' || p_user_id || ':' || now(),
    jsonb_build_object('message', 'You said you were not coming to ' || public.meal_label(v_ms)
      || ', but you came. Enjoy the meal! −' || v_pen || ' reward point' || case when v_pen = 1 then '' else 's' end
      || '. Next time, take your notice back if your plans change.'));
end $$;

-- Coupon recorded for someone who said "not coming" -> came anyway; that entry
-- voided -> undone (and rewarded again if the meal is already settled).
create function public.attendance_updates_rsvps() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_r public.meal_rsvps;
begin
  if new.holder_user_id is null then
    return null;
  end if;
  if tg_op = 'INSERT' and new.status = 'VALID' then
    if exists (select 1 from public.meal_rsvps where meal_service_id = new.meal_service_id and user_id = new.holder_user_id
                 and status = 'NOT_COMING' and outcome is distinct from 'CAME_ANYWAY') then
      perform public.rsvp_came_anyway(new.meal_service_id, new.holder_user_id, new.id, null);
    end if;
  elsif tg_op = 'UPDATE' and old.status = 'VALID' and new.status = 'VOIDED' then
    select * into v_r from public.meal_rsvps
    where meal_service_id = new.meal_service_id and user_id = new.holder_user_id and came_attendance_id = new.id
    for update;
    if v_r.meal_service_id is not null then
      if v_r.penalty_applied > 0 then
        insert into public.points_ledger (user_id, meal_service_id, kind, points, note)
        values (v_r.user_id, v_r.meal_service_id, 'REVERSAL', v_r.penalty_applied, 'Penalty undone: coupon entry voided');
      end if;
      update public.meal_rsvps set outcome = null, penalty_applied = 0, came_attendance_id = null, settled_at = null
      where meal_service_id = v_r.meal_service_id and user_id = v_r.user_id;
      if (select rsvp_settled_at from public.meal_services where id = v_r.meal_service_id) is not null then
        perform public.rsvp_reward(v_r.meal_service_id, v_r.user_id);
      end if;
    end if;
  end if;
  return null;
end $$;

create trigger attendance_updates_rsvps
  after insert or update of status on public.attendance_records
  for each row execute function public.attendance_updates_rsvps();

-- After a meal (closed, or an hour past its end): reward everyone who kept their
-- word, close open change requests. Cancelled meals settle with no points.
create function public.settle_rsvps() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  v_r public.meal_rsvps;
  v_n integer := 0;
begin
  for v_ms in
    select * from public.meal_services
    where rsvp_settled_at is null
      and (state in ('CLOSED', 'CANCELLED')
           or now() > coalesce(service_end_at, service_start_at + interval '3 hours') + interval '1 hour')
    for update skip locked
  loop
    if v_ms.state <> 'CANCELLED' then
      for v_r in
        select * from public.meal_rsvps
        where meal_service_id = v_ms.id and status = 'NOT_COMING' and outcome is null
        for update
      loop
        perform public.rsvp_reward(v_r.meal_service_id, v_r.user_id);
        v_n := v_n + 1;
      end loop;
    end if;
    update public.rsvp_change_requests
    set status = 'REJECTED', decided_at = now(), admin_note = 'The meal is over'
    where meal_service_id = v_ms.id and status = 'PENDING';
    update public.meal_services set rsvp_settled_at = now() where id = v_ms.id;
  end loop;
  return v_n;
end $$;

create or replace function public.run_due_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.run_admission_jobs() || public.process_no_shows()
         || jsonb_build_object('rewards_given', public.settle_rsvps());
end $$;

-- ---------------------------------------------------------------------------
-- Student actions
-- ---------------------------------------------------------------------------

-- p_not_coming = true: say "not coming". false: take it back (on your own
-- within the change window and before the deadline; otherwise a request to the
-- admins, with p_reason).
create function public.set_not_coming(p_meal_service_id uuid, p_not_coming boolean, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_cfg public.rsvp_settings := public.rsvp_config();
  v_ms public.meal_services;
  v_r public.meal_rsvps;
  v_deadline timestamptz;
  v_free_until timestamptz;
  v_req uuid;
begin
  if public.verified_coupon_id(v_uid) is null then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state <> 'SCHEDULED' or now() >= v_ms.service_start_at then
    return jsonb_build_object('status', 'MEAL_STARTED');
  end if;
  v_deadline := public.rsvp_deadline(v_ms);
  select * into v_r from public.meal_rsvps where meal_service_id = v_ms.id and user_id = v_uid for update;

  if p_not_coming then
    if v_r.status = 'NOT_COMING' then
      return jsonb_build_object('status', 'ALREADY_SET');
    end if;
    if now() >= v_deadline then
      return jsonb_build_object('status', 'PAST_DEADLINE', 'deadline', v_deadline);
    end if;
    if exists (select 1 from public.booking_participations
               where meal_service_id = v_ms.id and user_id = v_uid and status <> 'CANCELLED') then
      return jsonb_build_object('status', 'CANCEL_BOOKING_FIRST');
    end if;
    insert into public.meal_rsvps (meal_service_id, user_id, status)
    values (v_ms.id, v_uid, 'NOT_COMING')
    on conflict (meal_service_id, user_id) do update set status = 'NOT_COMING', set_at = now(), changed_at = null;
    perform public.write_audit('NOT_COMING_SET', 'meal_service', v_ms.id::text, null, jsonb_build_object('user', v_uid));
    return jsonb_build_object('status', 'OK',
      'change_until', least(now() + make_interval(mins => v_cfg.change_window_minutes), v_deadline));
  end if;

  if v_r.status is distinct from 'NOT_COMING' then
    return jsonb_build_object('status', 'NOT_SET');
  end if;
  v_free_until := least(v_r.set_at + make_interval(mins => v_cfg.change_window_minutes), v_deadline);
  if now() < v_free_until then
    update public.meal_rsvps set status = 'WITHDRAWN', changed_at = now()
    where meal_service_id = v_ms.id and user_id = v_uid;
    perform public.write_audit('NOT_COMING_WITHDRAWN', 'meal_service', v_ms.id::text, null, jsonb_build_object('user', v_uid));
    return jsonb_build_object('status', 'OK');
  end if;
  if exists (select 1 from public.rsvp_change_requests
             where meal_service_id = v_ms.id and user_id = v_uid and status = 'PENDING') then
    return jsonb_build_object('status', 'REQUEST_PENDING');
  end if;
  insert into public.rsvp_change_requests (meal_service_id, user_id, reason)
  values (v_ms.id, v_uid, nullif(left(btrim(p_reason), 300), ''))
  returning id into v_req;
  perform public.write_audit('NOT_COMING_CHANGE_REQUESTED', 'rsvp_change_request', v_req::text, null,
    jsonb_build_object('user', v_uid, 'meal', v_ms.id));
  return jsonb_build_object('status', 'REQUEST_SENT', 'request_id', v_req);
end $$;

-- ---------------------------------------------------------------------------
-- Admin actions
-- ---------------------------------------------------------------------------

create function public.decide_not_coming_change(p_request_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_req public.rsvp_change_requests;
  v_ms public.meal_services;
begin
  select * into v_req from public.rsvp_change_requests where id = p_request_id;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  select * into v_ms from public.meal_services where id = v_req.meal_service_id for update;
  select * into v_req from public.rsvp_change_requests where id = p_request_id for update;
  if v_req.status <> 'PENDING' then
    return jsonb_build_object('status', 'ALREADY_DECIDED');
  end if;
  update public.rsvp_change_requests
  set status = case when p_approve then 'APPROVED' else 'REJECTED' end, decided_by = v_uid, decided_at = now(),
      admin_note = nullif(left(btrim(p_note), 300), '')
  where id = p_request_id;
  if p_approve then
    update public.meal_rsvps set status = 'WITHDRAWN', changed_at = now()
    where meal_service_id = v_req.meal_service_id and user_id = v_req.user_id and outcome is null;
  end if;
  perform public.enqueue_notification(v_req.user_id, 'NOT_COMING_CHANGE_DECIDED', 'rsvp-change:' || p_request_id,
    jsonb_build_object('message', case when p_approve
      then 'Approved: you are down as coming to ' || public.meal_label(v_ms) || ' again.'
      else 'Not approved: you stay down as not coming to ' || public.meal_label(v_ms) || '.' end
      || coalesce(' Note: ' || nullif(btrim(p_note), ''), '')));
  perform public.write_audit(case when p_approve then 'NOT_COMING_CHANGE_APPROVED' else 'NOT_COMING_CHANGE_REJECTED' end,
    'rsvp_change_request', p_request_id::text, null, null, p_note);
  return jsonb_build_object('status', case when p_approve then 'APPROVED' else 'REJECTED' end);
end $$;

-- For meals where nobody typed coupons (or the attendant missed one): an admin saw them eat.
create function public.mark_came_anyway(p_meal_service_id uuid, p_user_id uuid, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
  v_r public.meal_rsvps;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if now() < v_ms.service_start_at then
    return jsonb_build_object('status', 'NOT_STARTED');
  end if;
  select * into v_r from public.meal_rsvps where meal_service_id = p_meal_service_id and user_id = p_user_id;
  if v_r.status is distinct from 'NOT_COMING' then
    return jsonb_build_object('status', 'NOT_SET');
  end if;
  if v_r.outcome = 'CAME_ANYWAY' then
    return jsonb_build_object('status', 'ALREADY_MARKED');
  end if;
  perform public.rsvp_came_anyway(p_meal_service_id, p_user_id, null,
    coalesce('Seen at the meal: ' || nullif(left(btrim(p_note), 250), ''), 'Seen at the meal by an admin'));
  perform public.write_audit('CAME_ANYWAY_MARKED', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('user', p_user_id), p_note);
  return jsonb_build_object('status', 'OK');
end $$;

-- A treat at a meal (extra payesh, an egg...) paid with reward points.
create function public.give_treat(p_user_id uuid, p_points integer, p_note text, p_meal_service_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_balance integer;
begin
  if p_points is null or p_points < 1 or p_points > 20 then
    raise exception 'points must be between 1 and 20' using errcode = '22023';
  end if;
  if nullif(btrim(p_note), '') is null then
    return jsonb_build_object('status', 'NOTE_REQUIRED');
  end if;
  perform 1 from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'user not found' using errcode = 'P0002';
  end if;
  v_balance := public.points_balance(p_user_id);
  if v_balance < p_points then
    return jsonb_build_object('status', 'NOT_ENOUGH_POINTS', 'balance', v_balance);
  end if;
  insert into public.points_ledger (user_id, meal_service_id, kind, points, note, created_by)
  values (p_user_id, p_meal_service_id, 'TREAT', -p_points, left(btrim(p_note), 300), v_uid);
  perform public.enqueue_notification(p_user_id, 'TREAT_GIVEN', 'treat:' || p_user_id || ':' || now(),
    jsonb_build_object('message', 'Enjoy your treat: ' || left(btrim(p_note), 100) || ' (−' || p_points || ' reward point'
      || case when p_points = 1 then '' else 's' end || ').'));
  perform public.write_audit('TREAT_GIVEN', 'profile', p_user_id::text, null,
    jsonb_build_object('points', p_points, 'meal', p_meal_service_id), p_note);
  return jsonb_build_object('status', 'OK', 'balance', v_balance - p_points);
end $$;

-- Notice period for one meal, in minutes before it starts; null = the default.
create function public.set_not_coming_deadline(p_meal_service_id uuid, p_lead_minutes integer) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
begin
  if p_lead_minutes is not null and (p_lead_minutes < 0 or p_lead_minutes > 10080) then
    return jsonb_build_object('status', 'INVALID_PERIOD');
  end if;
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if v_ms.state <> 'SCHEDULED' then
    return jsonb_build_object('status', 'MEAL_STARTED');
  end if;
  update public.meal_services set rsvp_lead_minutes = p_lead_minutes where id = p_meal_service_id
  returning * into v_ms;
  perform public.write_audit('NOT_COMING_DEADLINE_SET', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('lead_minutes', p_lead_minutes));
  return jsonb_build_object('status', 'OK', 'deadline', public.rsvp_deadline(v_ms));
end $$;

create function public.update_rsvp_settings(
  p_default_lead_minutes integer, p_change_window_minutes integer,
  p_reward_points integer, p_penalty_points integer, p_max_points integer
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_before public.rsvp_settings := public.rsvp_config();
begin
  if p_default_lead_minutes not between 0 and 2880 or p_change_window_minutes not between 0 and 2880
     or p_reward_points not between 0 and 10 or p_penalty_points not between 0 and 10 or p_max_points not between 1 and 20 then
    return jsonb_build_object('status', 'OUT_OF_RANGE');
  end if;
  update public.rsvp_settings
  set default_lead_minutes = p_default_lead_minutes, change_window_minutes = p_change_window_minutes,
      reward_points = p_reward_points, penalty_points = p_penalty_points, max_points = p_max_points,
      updated_by = v_uid, updated_at = now();
  perform public.write_audit('RSVP_SETTINGS_UPDATED', 'rsvp_settings', 'default', to_jsonb(v_before),
    to_jsonb(public.rsvp_config()));
  return jsonb_build_object('status', 'OK');
end $$;

-- ---------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------

create function public.rsvp_settings_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('default_lead_minutes', s.default_lead_minutes, 'change_window_minutes', s.change_window_minutes,
    'reward_points', s.reward_points, 'penalty_points', s.penalty_points, 'max_points', s.max_points)
  from public.rsvp_settings s
$$;

-- The caller's notice for one meal.
create function public.my_rsvp_json(p_ms public.meal_services, p_user_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'deadline', public.rsvp_deadline(p_ms),
    'open', p_ms.state = 'SCHEDULED' and now() < public.rsvp_deadline(p_ms),
    'started', p_ms.state <> 'SCHEDULED' or now() >= p_ms.service_start_at,
    'not_coming', coalesce(r.status = 'NOT_COMING', false),
    'set_at', r.set_at,
    'change_until', case when r.status = 'NOT_COMING' then least(
      r.set_at + make_interval(mins => (public.rsvp_config()).change_window_minutes), public.rsvp_deadline(p_ms)) end,
    'outcome', r.outcome, 'points_awarded', r.points_awarded, 'penalty_applied', r.penalty_applied,
    'request', (select jsonb_build_object('id', q.id, 'status', q.status, 'admin_note', q.admin_note)
                from public.rsvp_change_requests q
                where q.meal_service_id = p_ms.id and q.user_id = p_user_id order by q.created_at desc limit 1),
    'booked', exists (select 1 from public.booking_participations b
                      where b.meal_service_id = p_ms.id and b.user_id = p_user_id and b.status <> 'CANCELLED'))
  from (select 1) one
  left join public.meal_rsvps r on r.meal_service_id = p_ms.id and r.user_id = p_user_id
$$;

-- One meal: the caller's notice; for admins also the cooking count, the names,
-- open change requests and who has points for a treat.
create function public.meal_rsvp(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_admin boolean := public.current_app_role() >= 'ADMIN';
  v_ms public.meal_services;
  v_eligible integer;
  v_not integer;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if not v_admin then
    return jsonb_build_object('mine', public.my_rsvp_json(v_ms, v_uid));
  end if;
  select count(*) into v_eligible from public.coupon_claims c join public.profiles p on p.id = c.user_id
  where c.status = 'APPROVED' and p.is_verified;
  select count(*) into v_not from public.meal_rsvps where meal_service_id = v_ms.id and status = 'NOT_COMING';
  return jsonb_build_object(
    'mine', public.my_rsvp_json(v_ms, v_uid),
    'admin', jsonb_build_object(
      'eligible', v_eligible, 'not_coming', v_not, 'expected', greatest(v_eligible - v_not, 0),
      'deadline', public.rsvp_deadline(v_ms), 'lead_minutes', v_ms.rsvp_lead_minutes,
      'started', v_ms.state <> 'SCHEDULED' or now() >= v_ms.service_start_at,
      'settled', v_ms.rsvp_settled_at is not null,
      'people', coalesce((
        select jsonb_agg(jsonb_build_object('user_id', r.user_id, 'name', p.full_name,
                 'coupon_number', public.coupon_number_of(r.user_id), 'set_at', r.set_at, 'outcome', r.outcome)
               order by public.coupon_number_of(r.user_id))
        from public.meal_rsvps r join public.profiles p on p.id = r.user_id
        where r.meal_service_id = v_ms.id and r.status = 'NOT_COMING'), '[]'::jsonb),
      'requests', coalesce((
        select jsonb_agg(jsonb_build_object('id', q.id, 'user_id', q.user_id, 'name', p.full_name,
                 'coupon_number', public.coupon_number_of(q.user_id), 'reason', q.reason, 'created_at', q.created_at)
               order by q.created_at)
        from public.rsvp_change_requests q join public.profiles p on p.id = q.user_id
        where q.meal_service_id = v_ms.id and q.status = 'PENDING'), '[]'::jsonb),
      'treats', coalesce((
        select jsonb_agg(t order by (t ->> 'here')::boolean desc, (t ->> 'balance')::int desc, (t ->> 'coupon_number')::int)
        from (select jsonb_build_object('user_id', b.user_id, 'name', p.full_name,
                       'coupon_number', public.coupon_number_of(b.user_id), 'balance', b.balance,
                       'here', exists (select 1 from public.attendance_records a
                                       where a.meal_service_id = v_ms.id and a.holder_user_id = b.user_id
                                         and a.status = 'VALID')) as t
              from (select user_id, sum(points)::int as balance from public.points_ledger group by user_id) b
              join public.profiles p on p.id = b.user_id
              where b.balance > 0) x), '[]'::jsonb)));
end $$;

-- Meals in the next 7 days with the caller's notice, soonest first.
create function public.my_upcoming_meals() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.meal_brief(m) || jsonb_build_object('rsvp', public.my_rsvp_json(m, auth.uid()))
                            order by m.service_start_at), '[]'::jsonb)
  from public.meal_services m
  where public.require_role('STUDENT') is not null
    and m.state = 'SCHEDULED' and m.service_start_at > now() and m.service_start_at < now() + interval '7 days'
$$;

create function public.my_points() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'balance', public.points_balance(public.require_role('STUDENT')),
    'settings', public.rsvp_settings_json(),
    'came_anyway', (select count(*) from public.meal_rsvps where user_id = auth.uid() and outcome = 'CAME_ANYWAY'),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('kind', l.kind, 'points', l.points, 'note', l.note, 'created_at', l.created_at,
               'meal', case when m.id is not null then public.meal_brief(m) end) order by l.created_at desc)
      from (select * from public.points_ledger where user_id = auth.uid() order by created_at desc limit 30) l
      left join public.meal_services m on m.id = l.meal_service_id), '[]'::jsonb))
$$;

-- Admin overview: settings, open requests, upcoming notice counts, balances.
create function public.admin_rewards() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'settings', public.rsvp_settings_json(),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'name', p.full_name, 'coupon_number', public.coupon_number_of(q.user_id),
               'reason', q.reason, 'created_at', q.created_at, 'meal', public.meal_brief(m)) order by q.created_at)
      from public.rsvp_change_requests q join public.profiles p on p.id = q.user_id
      join public.meal_services m on m.id = q.meal_service_id
      where q.status = 'PENDING'), '[]'::jsonb),
    'upcoming', coalesce((
      select jsonb_agg(public.meal_brief(m) || jsonb_build_object('deadline', public.rsvp_deadline(m),
               'lead_minutes', m.rsvp_lead_minutes,
               'not_coming', (select count(*) from public.meal_rsvps r where r.meal_service_id = m.id and r.status = 'NOT_COMING'))
             order by m.service_start_at)
      from public.meal_services m
      where m.state in ('SCHEDULED', 'IN_SERVICE') and m.service_start_at > now() - interval '6 hours'), '[]'::jsonb),
    'balances', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', p.full_name, 'coupon_number', public.coupon_number_of(p.id),
               'balance', coalesce(b.balance, 0), 'kept', s.kept, 'came_anyway', s.came) order by coalesce(b.balance, 0) desc, p.full_name)
      from public.profiles p
      left join (select user_id, sum(points)::int as balance from public.points_ledger group by user_id) b on b.user_id = p.id
      left join (select user_id, count(*) filter (where outcome = 'REWARDED') as kept,
                        count(*) filter (where outcome = 'CAME_ANYWAY') as came
                 from public.meal_rsvps group by user_id) s on s.user_id = p.id
      where coalesce(b.balance, 0) <> 0 or coalesce(s.kept, 0) + coalesce(s.came, 0) > 0), '[]'::jsonb))
  where public.require_role('ADMIN') is not null
$$;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.rsvp_settings enable row level security;
alter table public.meal_rsvps enable row level security;
alter table public.rsvp_change_requests enable row level security;
alter table public.points_ledger enable row level security;

create policy meal_rsvps_select on public.meal_rsvps for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');
create policy rsvp_change_requests_select on public.rsvp_change_requests for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');
create policy points_ledger_select on public.points_ledger for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');
-- rsvp_settings: read through the functions only.

grant select on public.meal_rsvps, public.rsvp_change_requests, public.points_ledger to authenticated;

grant execute on function
  public.set_not_coming(uuid, boolean, text),
  public.decide_not_coming_change(uuid, boolean, text),
  public.mark_came_anyway(uuid, uuid, text),
  public.give_treat(uuid, integer, text, uuid),
  public.set_not_coming_deadline(uuid, integer),
  public.update_rsvp_settings(integer, integer, integer, integer, integer),
  public.meal_rsvp(uuid),
  public.my_upcoming_meals(),
  public.my_points(),
  public.admin_rewards()
to authenticated;
