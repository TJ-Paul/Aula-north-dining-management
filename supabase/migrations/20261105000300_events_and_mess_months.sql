-- Events, menus with alternatives, anonymous feedback, mess months with
-- their managers, manager ratings and the monthly handover.
--
-- Meals are Lunch, Dinner or Paron (a special meal admins schedule freely).
-- Any meal can be an Improvement or a Feast. Paron, Improvement and Feast
-- are "special events": students who ate there may rate that month's mess
-- managers (1–5 whole stars, any number of managers) and send feedback.
--
-- A mess month has a 1-based serial since launch, a name, dates and its
-- managers (a snapshot of name, coupon, room and phone, kept for history).
-- Scores are shown only after the month is over:
--     score = a manager's total stars / the highest rating count of any
--             manager in that month
-- so being rated more often also counts.
--
-- Handover: active managers (or the super admin) nominate students; a
-- nominee accepts or declines. The first to accept after a nomination round
-- creates the new month; later acceptors join it. Old managers then retire.

alter type public.meal_type add value if not exists 'PARON';
create type public.meal_occasion as enum ('REGULAR', 'IMPROVEMENT', 'FEAST');

alter table public.meal_services
  add column name text check (char_length(name) <= 80),
  add column occasion public.meal_occasion not null default 'REGULAR',
  add column description text check (char_length(description) <= 2000),
  add column service_end_at timestamptz,
  add constraint meal_services_end_after_start check (service_end_at is null or service_end_at > service_start_at);

-- (meal_type compared as text: the PARON value is new in this migration.)
create function public.meal_is_special(p_meal_type public.meal_type, p_occasion public.meal_occasion) returns boolean
language sql immutable as $$
  select p_meal_type::text = 'PARON' or p_occasion::text <> 'REGULAR'
$$;

create function public.dhaka_today() returns date
language sql stable as $$
  select (now() at time zone 'Asia/Dhaka')::date
$$;

-- ---------------------------------------------------------------------------
-- Menus and alternatives
-- ---------------------------------------------------------------------------

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  meal_service_id uuid not null references public.meal_services (id),
  position smallint not null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  unique (meal_service_id, position)
);

create table public.menu_alternatives (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.menu_items (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  unique (item_id, name)
);

-- A student's pick of an alternative instead of the item (no row = the item itself).
create table public.menu_choices (
  item_id uuid not null references public.menu_items (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  alternative_id uuid not null references public.menu_alternatives (id) on delete cascade,
  chosen_at timestamptz not null default now(),
  primary key (item_id, user_id)
);

-- Admin: name, kind, times, description and menu of a meal. The menu is
-- replaced as a whole; students' picks survive when the item and the
-- alternative keep their names.
create function public.set_meal_details(
  p_meal_service_id uuid, p_name text, p_occasion public.meal_occasion, p_description text,
  p_end_at timestamptz, p_items jsonb
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
  v_old jsonb;
  v_item jsonb;
  v_pos integer;
  v_item_id uuid;
  v_alt text;
  v_restored integer;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;
  if v_ms.state in ('CLOSED', 'CANCELLED') then
    return jsonb_build_object('status', 'MEAL_CLOSED');
  end if;
  if p_end_at is not null and p_end_at <= v_ms.service_start_at then
    return jsonb_build_object('status', 'END_BEFORE_START');
  end if;
  if p_items is not null and (jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30) then
    raise exception 'items must be a list of at most 30' using errcode = '22023';
  end if;

  if p_items is not null then
    select coalesce(jsonb_agg(jsonb_build_object('item', i.name, 'alt', a.name, 'user_id', c.user_id)), '[]'::jsonb)
    into v_old
    from public.menu_choices c
    join public.menu_items i on i.id = c.item_id
    join public.menu_alternatives a on a.id = c.alternative_id
    where i.meal_service_id = p_meal_service_id;

    delete from public.menu_items where meal_service_id = p_meal_service_id;
    for v_item, v_pos in select value, ordinality from jsonb_array_elements(p_items) with ordinality loop
      if char_length(btrim(coalesce(v_item ->> 'name', ''))) not between 1 and 80
         or (v_item ? 'alternatives' and (jsonb_typeof(v_item -> 'alternatives') <> 'array'
                                          or jsonb_array_length(v_item -> 'alternatives') > 5)) then
        raise exception 'each item needs a name; at most 5 alternatives' using errcode = '22023';
      end if;
      insert into public.menu_items (meal_service_id, position, name)
      values (p_meal_service_id, v_pos, btrim(v_item ->> 'name'))
      returning id into v_item_id;
      for v_alt in select distinct btrim(x) from jsonb_array_elements_text(coalesce(v_item -> 'alternatives', '[]'::jsonb)) x
                   where btrim(x) <> '' loop
        insert into public.menu_alternatives (item_id, name) values (v_item_id, v_alt);
      end loop;
    end loop;

    insert into public.menu_choices (item_id, user_id, alternative_id)
    select i.id, (o ->> 'user_id')::uuid, a.id
    from jsonb_array_elements(v_old) o
    join public.menu_items i on i.meal_service_id = p_meal_service_id and i.name = o ->> 'item'
    join public.menu_alternatives a on a.item_id = i.id and a.name = o ->> 'alt'
    on conflict do nothing;
    get diagnostics v_restored = row_count;
  end if;

  update public.meal_services
  set name = nullif(btrim(p_name), ''), occasion = coalesce(p_occasion, occasion),
      description = nullif(btrim(p_description), ''), service_end_at = p_end_at
  where id = p_meal_service_id;

  perform public.write_audit('MEAL_DETAILS_SET', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('name', p_name, 'occasion', p_occasion, 'items', jsonb_array_length(coalesce(p_items, '[]'::jsonb))));
  return jsonb_build_object('status', 'OK', 'choices_kept', coalesce(v_restored, 0));
end $$;

-- Admin: create a meal with all its details in one step. Breakfast is not used.
create function public.create_meal_event(
  p_service_date date, p_meal_type public.meal_type, p_start_at timestamptz, p_end_at timestamptz,
  p_name text, p_occasion public.meal_occasion, p_description text, p_items jsonb,
  p_policy_version integer default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_r jsonb;
  v_d jsonb;
begin
  if p_meal_type::text = 'BREAKFAST' then
    return jsonb_build_object('status', 'BREAKFAST_NOT_USED');
  end if;
  if p_end_at is not null and p_end_at <= p_start_at then
    return jsonb_build_object('status', 'END_BEFORE_START');
  end if;
  v_r := public.create_meal_service(p_service_date, p_meal_type, p_start_at, p_policy_version);
  if v_r ->> 'status' <> 'CREATED' then
    return v_r;
  end if;
  v_d := public.set_meal_details((v_r ->> 'meal_service_id')::uuid, p_name, p_occasion, p_description, p_end_at, p_items);
  return v_r || jsonb_build_object('details', v_d);
end $$;

-- Student: pick an alternative (or null to go back to the item) until the meal starts.
create function public.choose_alternative(p_item_id uuid, p_alternative_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_start timestamptz;
begin
  select m.service_start_at into v_start
  from public.menu_items i join public.meal_services m on m.id = i.meal_service_id
  where i.id = p_item_id;
  if v_start is null then
    raise exception 'item not found' using errcode = 'P0002';
  end if;
  if now() >= v_start then
    return jsonb_build_object('status', 'TOO_LATE');
  end if;
  if not (select is_verified from public.profiles where id = v_uid) then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  if p_alternative_id is null then
    delete from public.menu_choices where item_id = p_item_id and user_id = v_uid;
    return jsonb_build_object('status', 'OK');
  end if;
  if not exists (select 1 from public.menu_alternatives where id = p_alternative_id and item_id = p_item_id) then
    raise exception 'that alternative is not offered for this item' using errcode = '22023';
  end if;
  insert into public.menu_choices (item_id, user_id, alternative_id) values (p_item_id, v_uid, p_alternative_id)
  on conflict (item_id, user_id) do update set alternative_id = excluded.alternative_id, chosen_at = now();
  return jsonb_build_object('status', 'OK');
end $$;

-- ---------------------------------------------------------------------------
-- Mess months and managers
-- ---------------------------------------------------------------------------

create table public.mess_months (
  id uuid primary key default gen_random_uuid(),
  serial integer not null unique check (serial >= 1),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  starts_on date not null,
  ends_on date not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint mess_months_dates check (ends_on >= starts_on and ends_on - starts_on <= 92)
);

create table public.mess_managers (
  mess_month_id uuid not null references public.mess_months (id),
  user_id uuid not null references public.profiles (id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  joined_at timestamptz not null default now(),
  retired_at timestamptz,
  -- As they were when they took over, kept for the record.
  name text not null,
  coupon_number integer,
  room text,
  phone text,
  primary key (mess_month_id, user_id),
  constraint mess_managers_retired_shape check ((status = 'RETIRED') = (retired_at is not null))
);

create table public.manager_nominations (
  id uuid primary key default gen_random_uuid(),
  nominee_id uuid not null references public.profiles (id),
  nominated_by uuid not null references public.profiles (id),
  note text check (char_length(note) <= 300),
  -- Made by a manager of the current month: it is for the next month. Otherwise
  -- (super admin, or managers of an older month) it joins the current month while it runs.
  for_next_month boolean not null default true,
  status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  mess_month_id uuid references public.mess_months (id)
);
create unique index manager_nominations_one_pending on public.manager_nominations (nominee_id) where status = 'PENDING';

create function public.latest_mess_month() returns public.mess_months
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.mess_months order by serial desc limit 1
$$;

-- The month a meal belongs to: the newest month whose dates cover the meal's date.
create function public.mess_month_of(p_service_date date) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from public.mess_months where p_service_date between starts_on and ends_on order by serial desc limit 1
$$;

create function public.mess_month_over(p_month public.mess_months) returns boolean
language sql stable as $$
  select public.dhaka_today() > p_month.ends_on
$$;

create function public.is_active_manager(p_user_id uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.mess_managers m
                 where m.user_id = p_user_id and m.status = 'ACTIVE'
                   and m.mess_month_id = (select id from public.latest_mess_month()))
$$;

create function public.nominate_manager(p_user_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_id uuid;
begin
  if public.current_app_role() <> 'SUPER_ADMIN' and not public.is_active_manager(v_uid) then
    raise exception 'only the current mess managers or a super admin can nominate' using errcode = '42501';
  end if;
  if public.verified_coupon_id(p_user_id) is null then
    return jsonb_build_object('status', 'NOT_A_VERIFIED_STUDENT');
  end if;
  if exists (select 1 from public.manager_nominations where nominee_id = p_user_id and status = 'PENDING') then
    return jsonb_build_object('status', 'ALREADY_NOMINATED');
  end if;
  insert into public.manager_nominations (nominee_id, nominated_by, note, for_next_month)
  values (p_user_id, v_uid, nullif(btrim(p_note), ''), public.is_active_manager(v_uid))
  returning id into v_id;
  perform public.enqueue_notification(p_user_id, 'MANAGER_NOMINATED', 'manager-nominated:' || v_id,
    jsonb_build_object('message', (select full_name from public.profiles where id = v_uid)
                                  || ' nominated you as a mess manager. Open the app to accept or decline.'));
  perform public.write_audit('MANAGER_NOMINATED', 'manager_nomination', v_id::text, null,
    jsonb_build_object('nominee', p_user_id));
  return jsonb_build_object('status', 'NOMINATED', 'nomination_id', v_id);
end $$;

create function public.cancel_nomination(p_nomination_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  update public.manager_nominations set status = 'CANCELLED', decided_at = now()
  where id = p_nomination_id and status = 'PENDING'
    and (nominated_by = v_uid or public.current_app_role() = 'SUPER_ADMIN');
  if not found then
    return jsonb_build_object('status', 'NOT_PENDING');
  end if;
  perform public.write_audit('MANAGER_NOMINATION_CANCELLED', 'manager_nomination', p_nomination_id::text, null, null);
  return jsonb_build_object('status', 'CANCELLED');
end $$;

-- The signed-in student's pending nomination, and whether accepting creates a
-- new month or joins the one another nominee already set up.
create function public.my_nomination() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when n.id is null then null else jsonb_build_object(
    'nomination_id', n.id, 'nominated_by', p.full_name, 'note', n.note, 'created_at', n.created_at,
    'join_month', (select jsonb_build_object('id', l.id, 'serial', l.serial, 'name', l.name,
                                             'starts_on', l.starts_on, 'ends_on', l.ends_on)
                   from public.latest_mess_month() l
                   where l.id is not null
                     and (l.created_at >= n.created_at or (not n.for_next_month and not public.mess_month_over(l)))),
    'next_serial', coalesce((select max(serial) from public.mess_months), 0) + 1) end
  from (select * from public.manager_nominations
        where nominee_id = auth.uid() and status = 'PENDING') n
  left join public.profiles p on p.id = n.nominated_by
$$;

create function public.respond_to_nomination(
  p_nomination_id uuid, p_accept boolean,
  p_month_name text default null, p_starts_on date default null, p_ends_on date default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_nom public.manager_nominations;
  v_latest public.mess_months;
  v_month public.mess_months;
  v_created boolean := false;
  v_profile public.profiles;
begin
  select * into v_nom from public.manager_nominations where id = p_nomination_id and nominee_id = v_uid for update;
  if not found then
    raise exception 'nomination not found' using errcode = 'P0002';
  end if;
  if v_nom.status <> 'PENDING' then
    return jsonb_build_object('status', 'NOT_PENDING', 'nomination_status', v_nom.status);
  end if;

  if not coalesce(p_accept, false) then
    update public.manager_nominations set status = 'REJECTED', decided_at = now() where id = p_nomination_id;
    perform public.enqueue_notification(v_nom.nominated_by, 'MANAGER_DECLINED', 'manager-declined:' || p_nomination_id,
      jsonb_build_object('message', (select full_name from public.profiles where id = v_uid) || ' declined the mess manager nomination.'));
    perform public.write_audit('MANAGER_NOMINATION_REJECTED', 'manager_nomination', p_nomination_id::text, null, null);
    return jsonb_build_object('status', 'REJECTED');
  end if;

  -- Serialise acceptances so only one nominee creates the new month.
  perform pg_advisory_xact_lock(hashtextextended('mess-month-handover', 0));
  v_latest := public.latest_mess_month();

  if v_latest.id is not null
     and (v_latest.created_at >= v_nom.created_at                                   -- another nominee set it up
          or (not v_nom.for_next_month and not public.mess_month_over(v_latest))) then -- joining the running month
    v_month := v_latest;
  else
    if char_length(btrim(coalesce(p_month_name, ''))) < 2 or p_starts_on is null or p_ends_on is null then
      return jsonb_build_object('status', 'MONTH_DETAILS_REQUIRED',
        'next_serial', coalesce(v_latest.serial, 0) + 1);
    end if;
    if p_ends_on < p_starts_on or p_ends_on - p_starts_on > 92 then
      return jsonb_build_object('status', 'INVALID_DATES');
    end if;
    if v_latest.id is not null and p_starts_on <= v_latest.starts_on then
      return jsonb_build_object('status', 'STARTS_BEFORE_CURRENT_MONTH', 'current_starts_on', v_latest.starts_on);
    end if;
    insert into public.mess_months (serial, name, starts_on, ends_on, created_by)
    values (coalesce(v_latest.serial, 0) + 1, btrim(p_month_name), p_starts_on, p_ends_on, v_uid)
    returning * into v_month;
    v_created := true;
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  insert into public.mess_managers (mess_month_id, user_id, name, coupon_number, room, phone)
  values (v_month.id, v_uid, v_profile.full_name,
          (select k.coupon_number from public.coupon_claims c join public.coupons k on k.id = c.coupon_id
           where c.user_id = v_uid and c.status = 'APPROVED'),
          v_profile.room, v_profile.notify_phone)
  on conflict (mess_month_id, user_id) do update set status = 'ACTIVE', retired_at = null;

  update public.profiles set role = 'ADMIN', updated_at = now() where id = v_uid and role = 'STUDENT';
  update public.manager_nominations set status = 'ACCEPTED', decided_at = now(), mess_month_id = v_month.id
  where id = p_nomination_id;

  perform public.enqueue_notification(v_nom.nominated_by, 'MANAGER_ACCEPTED', 'manager-accepted:' || p_nomination_id,
    jsonb_build_object('message', v_profile.full_name || ' accepted and is now a mess manager of mess month '
                                  || v_month.serial || ' (' || v_month.name || '). You can retire when ready.'));
  perform public.write_audit('MANAGER_NOMINATION_ACCEPTED', 'mess_month', v_month.id::text, null,
    jsonb_build_object('user_id', v_uid, 'created_month', v_created, 'serial', v_month.serial));

  return jsonb_build_object('status', 'ACCEPTED', 'mess_month_id', v_month.id, 'serial', v_month.serial,
                            'created_month', v_created);
end $$;

-- A manager retires once a newer month has managers. A super admin can retire anyone at any time.
create function public.retire_manager(p_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_target uuid := coalesce(p_user_id, v_uid);
  v_super boolean := public.current_app_role() = 'SUPER_ADMIN';
  v_latest public.mess_months := public.latest_mess_month();
  v_n integer;
begin
  if v_target <> v_uid and not v_super then
    raise exception 'only a super admin can retire someone else' using errcode = '42501';
  end if;
  if not v_super and exists (select 1 from public.mess_managers
                             where user_id = v_target and status = 'ACTIVE' and mess_month_id = v_latest.id) then
    return jsonb_build_object('status', 'NO_SUCCESSOR',
      'message', 'Hand over first: nominate the next managers and wait until one accepts.');
  end if;

  update public.mess_managers set status = 'RETIRED', retired_at = now()
  where user_id = v_target and status = 'ACTIVE';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('status', 'NOT_ACTIVE');
  end if;
  update public.profiles set role = 'STUDENT', updated_at = now() where id = v_target and role = 'ADMIN';
  perform public.write_audit('MANAGER_RETIRED', 'profile', v_target::text, null, jsonb_build_object('by', v_uid));
  return jsonb_build_object('status', 'RETIRED');
end $$;

-- ---------------------------------------------------------------------------
-- Ratings
-- ---------------------------------------------------------------------------

create table public.manager_ratings (
  meal_service_id uuid not null references public.meal_services (id),
  rater_id uuid not null references public.profiles (id),
  manager_id uuid not null references public.profiles (id),
  mess_month_id uuid not null references public.mess_months (id),
  stars smallint not null check (stars between 1 and 5),
  rated_at timestamptz not null default now(),
  primary key (meal_service_id, rater_id, manager_id),
  constraint manager_ratings_not_self check (rater_id <> manager_id)
);
create index manager_ratings_month_idx on public.manager_ratings (mess_month_id, manager_id);

-- Student who ate at a special event: rate any of that month's managers
-- (the list replaces their earlier ratings for this event). Open until the month is over.
create function public.rate_managers(p_meal_service_id uuid, p_ratings jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
  v_month public.mess_months;
  r jsonb;
  v_n integer := 0;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if not public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
    return jsonb_build_object('status', 'NOT_RATEABLE');
  end if;
  if not exists (select 1 from public.attendance_records
                 where meal_service_id = p_meal_service_id and holder_user_id = v_uid and status = 'VALID') then
    return jsonb_build_object('status', 'NOT_ATTENDED');
  end if;
  select * into v_month from public.mess_months where id = public.mess_month_of(v_ms.service_date);
  if v_month.id is null then
    return jsonb_build_object('status', 'NO_MESS_MONTH');
  end if;
  if public.mess_month_over(v_month) then
    return jsonb_build_object('status', 'RATING_CLOSED');
  end if;
  if p_ratings is null or jsonb_typeof(p_ratings) <> 'array' then
    raise exception 'ratings must be a list' using errcode = '22023';
  end if;

  delete from public.manager_ratings where meal_service_id = p_meal_service_id and rater_id = v_uid;
  for r in select * from jsonb_array_elements(p_ratings) loop
    if (r ->> 'stars') !~ '^[1-5]$' then
      raise exception 'stars must be a whole number from 1 to 5' using errcode = '22023';
    end if;
    if not exists (select 1 from public.mess_managers
                   where mess_month_id = v_month.id and user_id = (r ->> 'manager_id')::uuid) then
      raise exception 'not a mess manager of this month' using errcode = '22023';
    end if;
    if (r ->> 'manager_id')::uuid = v_uid then
      raise exception 'you cannot rate yourself' using errcode = '22023';
    end if;
    insert into public.manager_ratings (meal_service_id, rater_id, manager_id, mess_month_id, stars)
    values (p_meal_service_id, v_uid, (r ->> 'manager_id')::uuid, v_month.id, (r ->> 'stars')::smallint);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('status', 'OK', 'rated', v_n);
end $$;

-- Per-manager results of a month: count, total stars and the score.
create function public.mess_month_scores(p_mess_month_id uuid) returns table (
  user_id uuid, rated_count integer, total_stars integer, score numeric
)
language sql stable security definer set search_path = public, pg_temp as $$
  with per as (
    select m.user_id, count(r.*)::integer as n, coalesce(sum(r.stars), 0)::integer as total
    from public.mess_managers m
    left join public.manager_ratings r on r.mess_month_id = m.mess_month_id and r.manager_id = m.user_id
    where m.mess_month_id = p_mess_month_id
    group by m.user_id
  )
  select per.user_id, per.n, per.total,
         case when max(per.n) over () = 0 then null
              else round(per.total::numeric / max(per.n) over (), 2) end
  from per
$$;

-- ---------------------------------------------------------------------------
-- Anonymous feedback
-- ---------------------------------------------------------------------------

-- No sender is stored. The quota table (who, how many per day) is never joined to it.
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('COMPLAINT', 'FEEDBACK', 'SUGGESTION')),
  meal_service_id uuid references public.meal_services (id),
  mess_month_id uuid references public.mess_months (id),
  body text not null check (char_length(btrim(body)) between 3 and 2000),
  created_on date not null default public.dhaka_today(),   -- day only, to make timing less identifying
  status text not null default 'NEW' check (status in ('NEW', 'SEEN', 'RESOLVED')),
  admin_note text check (char_length(admin_note) <= 1000),
  handled_by uuid references public.profiles (id),
  handled_at timestamptz
);

create table public.feedback_quota (
  user_id uuid not null references public.profiles (id),
  day date not null,
  sent integer not null default 0,
  primary key (user_id, day)
);

create function public.submit_feedback(p_kind text, p_body text, p_meal_service_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_ms public.meal_services;
  v_sent integer;
begin
  if not (select is_verified from public.profiles where id = v_uid) then
    return jsonb_build_object('status', 'NOT_VERIFIED');
  end if;
  if p_kind not in ('COMPLAINT', 'FEEDBACK', 'SUGGESTION') then
    raise exception 'kind must be COMPLAINT, FEEDBACK or SUGGESTION' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 3 and 2000 then
    raise exception 'write between 3 and 2000 characters' using errcode = '22023';
  end if;
  if p_meal_service_id is not null then
    select * into v_ms from public.meal_services where id = p_meal_service_id;
    if not found or not public.meal_is_special(v_ms.meal_type, v_ms.occasion) then
      return jsonb_build_object('status', 'NOT_AN_EVENT');
    end if;
  end if;

  insert into public.feedback_quota (user_id, day, sent) values (v_uid, public.dhaka_today(), 1)
  on conflict (user_id, day) do update set sent = feedback_quota.sent + 1
  returning sent into v_sent;
  if v_sent > 10 then
    return jsonb_build_object('status', 'DAILY_LIMIT');
  end if;

  insert into public.feedback (kind, meal_service_id, mess_month_id, body)
  values (p_kind, p_meal_service_id,
          coalesce(public.mess_month_of(coalesce(v_ms.service_date, public.dhaka_today())), (public.latest_mess_month()).id),
          btrim(p_body));
  return jsonb_build_object('status', 'SENT');
end $$;

create function public.list_feedback(p_mess_month_id uuid default null, p_include_resolved boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'body', f.body, 'created_on', f.created_on, 'status', f.status,
      'admin_note', f.admin_note, 'handled_by', p.full_name, 'handled_at', f.handled_at,
      'event', case when m.id is null then null else jsonb_build_object(
        'id', m.id, 'name', m.name, 'meal_type', m.meal_type, 'occasion', m.occasion, 'service_start_at', m.service_start_at) end)
      order by (f.status = 'RESOLVED'), f.created_on desc, f.id)
    from public.feedback f
    left join public.meal_services m on m.id = f.meal_service_id
    left join public.profiles p on p.id = f.handled_by
    where (p_mess_month_id is null or f.mess_month_id = p_mess_month_id)
      and (p_include_resolved or f.status <> 'RESOLVED')
  ), '[]'::jsonb);
end $$;

create function public.update_feedback(p_feedback_id uuid, p_status text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
begin
  if p_status not in ('NEW', 'SEEN', 'RESOLVED') then
    raise exception 'unknown status' using errcode = '22023';
  end if;
  update public.feedback
  set status = p_status, admin_note = coalesce(nullif(btrim(p_note), ''), admin_note), handled_by = v_uid, handled_at = now()
  where id = p_feedback_id;
  if not found then
    raise exception 'feedback not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('status', 'OK');
end $$;

-- ---------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------

create function public.meal_brief(p_ms public.meal_services) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', p_ms.id, 'service_date', p_ms.service_date, 'meal_type', p_ms.meal_type, 'occasion', p_ms.occasion,
    'name', p_ms.name, 'service_start_at', p_ms.service_start_at, 'service_end_at', p_ms.service_end_at,
    'state', p_ms.state, 'special', public.meal_is_special(p_ms.meal_type, p_ms.occasion))
$$;

-- Special events, upcoming and from the last p_days days.
create function public.meal_events(p_days integer default 45) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.meal_brief(m) || jsonb_build_object(
           'attended', exists (select 1 from public.attendance_records a
                               where a.meal_service_id = m.id and a.holder_user_id = auth.uid() and a.status = 'VALID'))
         order by m.service_start_at desc), '[]'::jsonb)
  from public.meal_services m
  where public.meal_is_special(m.meal_type, m.occasion) and m.state <> 'CANCELLED'
    and m.service_start_at > now() - make_interval(days => least(greatest(p_days, 1), 400))
$$;

create function public.event_detail(p_meal_service_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_admin boolean := public.current_app_role() >= 'ADMIN';
  v_ms public.meal_services;
  v_month public.mess_months;
  v_attended boolean;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  select * into v_month from public.mess_months where id = public.mess_month_of(v_ms.service_date);
  v_attended := exists (select 1 from public.attendance_records a
                        where a.meal_service_id = v_ms.id and a.holder_user_id = v_uid and a.status = 'VALID');

  return public.meal_brief(v_ms) || jsonb_build_object(
    'description', v_ms.description,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name,
        'alternatives', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) order by a.name)
                                  from public.menu_alternatives a where a.item_id = i.id), '[]'::jsonb),
        'my_choice', (select c.alternative_id from public.menu_choices c where c.item_id = i.id and c.user_id = v_uid),
        'totals', case when v_admin then (
          select jsonb_agg(jsonb_build_object('alternative', a.name,
                   'count', (select count(*) from public.menu_choices c where c.alternative_id = a.id)) order by a.name)
          from public.menu_alternatives a where a.item_id = i.id) end)
        order by i.position)
      from public.menu_items i where i.meal_service_id = v_ms.id), '[]'::jsonb),
    'can_choose', now() < v_ms.service_start_at,
    'attended', v_attended,
    'mess_month', case when v_month.id is null then null else jsonb_build_object(
      'id', v_month.id, 'serial', v_month.serial, 'name', v_month.name, 'over', public.mess_month_over(v_month)) end,
    'managers', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', mm.user_id, 'name', mm.name, 'status', mm.status,
                                          'my_stars', (select r.stars from public.manager_ratings r
                                                       where r.meal_service_id = v_ms.id and r.rater_id = v_uid
                                                         and r.manager_id = mm.user_id)) order by mm.name)
      from public.mess_managers mm where mm.mess_month_id = v_month.id), '[]'::jsonb),
    'can_rate', public.meal_is_special(v_ms.meal_type, v_ms.occasion) and v_attended
                and v_month.id is not null and not public.mess_month_over(v_month),
    'can_send_feedback', public.meal_is_special(v_ms.meal_type, v_ms.occasion),
    'attendance', case when v_admin then (select count(*) from public.attendance_records a
                                          where a.meal_service_id = v_ms.id and a.status = 'VALID') end);
end $$;

-- Mess month dashboard: every month (newest first) and one month in detail.
-- Scores appear only once that month is over; feedback only for admins.
create function public.mess_dashboard(p_mess_month_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_admin boolean := public.current_app_role() >= 'ADMIN';
  v_month public.mess_months;
  v_over boolean;
begin
  if p_mess_month_id is null then
    v_month := public.latest_mess_month();
  else
    select * into v_month from public.mess_months where id = p_mess_month_id;
  end if;
  v_over := v_month.id is not null and public.mess_month_over(v_month);

  return jsonb_build_object(
    'months', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'serial', serial, 'name', name,
                                                            'starts_on', starts_on, 'ends_on', ends_on,
                                                            'over', public.mess_month_over(mm)) order by serial desc)
                        from public.mess_months mm), '[]'::jsonb),
    'is_admin', v_admin,
    'i_am_active_manager', public.is_active_manager(v_uid),
    'month', case when v_month.id is null then null else jsonb_build_object(
      'id', v_month.id, 'serial', v_month.serial, 'name', v_month.name,
      'starts_on', v_month.starts_on, 'ends_on', v_month.ends_on, 'over', v_over,
      'is_latest', v_month.id = (public.latest_mess_month()).id,
      'managers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', m.user_id, 'name', m.name, 'coupon_number', m.coupon_number, 'room', m.room, 'phone', m.phone,
          'status', m.status, 'joined_at', m.joined_at, 'retired_at', m.retired_at,
          'rated_count', case when v_over then s.rated_count end,
          'total_stars', case when v_over then s.total_stars end,
          'score', case when v_over then s.score end)
          order by case when v_over then s.score end desc nulls last, m.joined_at)
        from public.mess_managers m
        left join public.mess_month_scores(v_month.id) s on s.user_id = m.user_id
        where m.mess_month_id = v_month.id), '[]'::jsonb),
      'counts', (select jsonb_build_object(
          'meals', count(*),
          'improvements', count(*) filter (where ms.occasion = 'IMPROVEMENT'),
          'feasts', count(*) filter (where ms.occasion = 'FEAST'),
          'parons', count(*) filter (where ms.meal_type::text = 'PARON'))
        from public.meal_services ms
        where ms.state <> 'CANCELLED' and ms.service_date between v_month.starts_on and v_month.ends_on),
      'events', coalesce((
        select jsonb_agg(public.meal_brief(ms) || jsonb_build_object(
          'attendance', (select count(*) from public.attendance_records a where a.meal_service_id = ms.id and a.status = 'VALID'),
          'feedback', case when v_admin then (select count(*) from public.feedback f where f.meal_service_id = ms.id) end)
          order by ms.service_start_at)
        from public.meal_services ms
        where ms.state <> 'CANCELLED' and ms.service_date between v_month.starts_on and v_month.ends_on
          and public.meal_is_special(ms.meal_type, ms.occasion)), '[]'::jsonb),
      'feedback', case when v_admin then public.list_feedback(v_month.id, true) end) end,
    'nominations', case when v_admin then coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'nominee', p.full_name, 'nominated_by', b.full_name,
                                          'status', n.status, 'created_at', n.created_at) order by n.created_at desc)
      from public.manager_nominations n
      join public.profiles p on p.id = n.nominee_id join public.profiles b on b.id = n.nominated_by
      where n.status = 'PENDING' or n.created_at > now() - interval '30 days'), '[]'::jsonb) end);
end $$;

-- Meals now carry names, kinds and end times in the existing read models.
create or replace function public.active_meal_services() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(public.meal_brief(m) order by m.service_start_at), '[]'::jsonb)
  from public.meal_services m
  where m.state in ('SCHEDULED', 'IN_SERVICE')
    and m.service_start_at between now() - interval '18 hours' and now() + interval '18 hours'
$$;

-- The admin Meals list, now with names, kinds, end times and menus.
create or replace function public.admin_meal_services(p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.require_role('ADMIN');
  return jsonb_build_object(
    'meals', coalesce((
      select jsonb_agg(m.item order by m.service_start_at desc)
      from (
        select ms.service_start_at, jsonb_build_object(
          'id', ms.id, 'service_date', ms.service_date, 'meal_type', ms.meal_type,
          'service_start_at', ms.service_start_at, 'state', ms.state, 'policy_version', ms.policy_version,
          'name', ms.name, 'occasion', ms.occasion, 'service_end_at', ms.service_end_at, 'description', ms.description,
          'special', public.meal_is_special(ms.meal_type, ms.occasion),
          'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name,
                               'alternatives', coalesce((select jsonb_agg(a.name order by a.name) from public.menu_alternatives a
                                                         where a.item_id = i.id), '[]'::jsonb)) order by i.position)
                             from public.menu_items i where i.meal_service_id = ms.id), '[]'::jsonb),
          'invitations_paused', ms.invitations_paused,
          'live_waves', coalesce((select jsonb_agg(jsonb_build_object('aisle', w.aisle_code, 'wave_number', w.wave_number,
                                                                      'phase', w.phase) order by w.aisle_code)
                                  from public.aisle_waves w where w.meal_service_id = ms.id and w.phase <> 'CLOSED'), '[]'::jsonb),
          'confirmed', (select count(*) from public.booking_participations p
                        where p.meal_service_id = ms.id and p.status in ('CONFIRMED', 'INVITED')),
          'standby', (select count(*) from public.booking_participations p
                      where p.meal_service_id = ms.id and p.status in ('STANDBY', 'OFFERED')),
          'diners', (select count(*) from public.attendance_records r
                     where r.meal_service_id = ms.id and r.status = 'VALID')) as item
        from public.meal_services ms
        order by ms.service_start_at desc
        limit least(greatest(p_limit, 1), 100)
      ) m), '[]'::jsonb),
    'aisles', (select jsonb_agg(jsonb_build_object('aisle', s.aisle_code, 'readiness', s.readiness,
                                                   'display_state', s.display_state, 'meal_service_id', s.meal_service_id,
                                                   'wave_number', s.wave_number) order by s.aisle_code)
               from public.aisle_status s),
    'policies', (select jsonb_agg(jsonb_build_object('version', version, 'note', note, 'is_active', is_active,
                                                     'settings', settings) order by version)
                 from public.policy_settings));
end $$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.menu_items enable row level security;
alter table public.menu_alternatives enable row level security;
alter table public.menu_choices enable row level security;
alter table public.mess_months enable row level security;
alter table public.mess_managers enable row level security;
alter table public.manager_nominations enable row level security;
alter table public.manager_ratings enable row level security;
alter table public.feedback enable row level security;
alter table public.feedback_quota enable row level security;

create policy menu_items_select on public.menu_items for select to authenticated using (true);
create policy menu_alternatives_select on public.menu_alternatives for select to authenticated using (true);
create policy menu_choices_select on public.menu_choices for select to authenticated
  using (user_id = auth.uid() or public.current_app_role() >= 'ADMIN');
create policy mess_months_select on public.mess_months for select to authenticated using (true);
create policy mess_managers_select on public.mess_managers for select to authenticated using (true);
create policy manager_nominations_select on public.manager_nominations for select to authenticated
  using (nominee_id = auth.uid() or nominated_by = auth.uid() or public.current_app_role() >= 'ADMIN');
-- Individual ratings are private to the person who gave them; results only through mess_dashboard.
create policy manager_ratings_select on public.manager_ratings for select to authenticated using (rater_id = auth.uid());
create policy feedback_select on public.feedback for select to authenticated using (public.current_app_role() >= 'ADMIN');
-- feedback_quota: no policies, no grants.

grant select on public.menu_items, public.menu_alternatives, public.menu_choices, public.mess_months,
  public.mess_managers, public.manager_nominations, public.manager_ratings, public.feedback to authenticated;

grant execute on function
  public.set_meal_details(uuid, text, public.meal_occasion, text, timestamptz, jsonb),
  public.create_meal_event(date, public.meal_type, timestamptz, timestamptz, text, public.meal_occasion, text, jsonb, integer),
  public.choose_alternative(uuid, uuid),
  public.nominate_manager(uuid, text),
  public.cancel_nomination(uuid),
  public.my_nomination(),
  public.respond_to_nomination(uuid, boolean, text, date, date),
  public.retire_manager(uuid),
  public.rate_managers(uuid, jsonb),
  public.submit_feedback(text, text, uuid),
  public.list_feedback(uuid, boolean),
  public.update_feedback(uuid, text, text),
  public.meal_events(integer),
  public.event_detail(uuid),
  public.mess_dashboard(uuid)
to authenticated;
