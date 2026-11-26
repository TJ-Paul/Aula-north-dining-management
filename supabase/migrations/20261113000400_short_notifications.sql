-- Short notifications (2026-11-13).
--
-- Every notification is a short title and one short line, e.g.
--   🍽️ Lunch            Fri 13 Nov. 1. গিলা কলিজা, 2. মুরগি
--   ✏️ Lunch updated    Thu 12 Nov. 1. Rice, 2. Dal
--   ✅ Dined            Lunch · Fri 13 Nov
-- The title rides in payload.title (the push sender falls back to a title per kind).
--
-- When meal notices are sent:
-- * a meal is created (for a future time): everyone, once (MEAL_NEW);
-- * a regular lunch/dinner starts: everyone, once, with the menu as it is then (MEAL_START);
-- * a meal is edited after its start: everyone (MEAL_EDITED). Edits before the start stay quiet;
-- * a meal is cancelled: everyone (MEAL_CANCELLED);
-- * "booking open", "batch full" and "gate open" are only for special meals (improvement, feast, paron).
-- Tapping a notification opens the home screen; an announcement opens the announcements page
-- (decided by the push sender, see lib/push-send.ts).

-- ---------------------------------------------------------------------------
-- The pieces of a meal notice
-- ---------------------------------------------------------------------------

-- "Lunch", or the meal's own name ("Improvement-11").
create or replace function public.meal_notice_title(p_ms public.meal_services) returns text
language sql stable as $$
  select coalesce(nullif(btrim(p_ms.name), ''), initcap(p_ms.meal_type::text))
$$;

-- "Fri 13 Nov"
create or replace function public.meal_notice_day(p_ms public.meal_services) returns text
language sql stable as $$
  select to_char(p_ms.service_start_at at time zone 'Asia/Dhaka', 'Dy FMDD Mon')
$$;

-- "Fri 13 Nov. 1. Rice, 2. Dal" (just the day when there is no menu yet).
create or replace function public.meal_notice_body(p_ms public.meal_services) returns text
language sql stable as $$
  select public.meal_notice_day(p_ms) || coalesce('. ' || (
    select string_agg(n || '. ' || x, ', ' order by n)
    from jsonb_array_elements_text(public.meal_brief(p_ms) -> 'menu') with ordinality as t(x, n)), '')
$$;

-- "Lunch · Fri 13 Nov" (used inside other notices).
create or replace function public.meal_notice_label(p_ms public.meal_services) returns text
language sql stable as $$
  select public.meal_notice_title(p_ms) || ' · ' || public.meal_notice_day(p_ms)
$$;

-- One notification for every active account, with a title.
create or replace function public.notify_everyone_titled(p_kind text, p_key text, p_title text, p_message text,
                                                         p_meal uuid default null) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  insert into public.notification_outbox (recipient_id, kind, event_key, payload)
  select p.id, p_kind, p_key || ':' || p.id,
         jsonb_strip_nulls(jsonb_build_object('title', p_title, 'message', p_message, 'url', '/', 'meal', p_meal))
  from public.profiles p
  where p.deleted_at is null and p.role::text <> 'VIEWER'
  on conflict (event_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.notify_everyone_titled(text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.announce_meal(p_meal_service_id uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  if not found then return; end if;
  if p_kind = 'MEAL_CANCELLED' then
    perform public.notify_everyone_titled(p_kind, 'meal_cancelled:' || v_ms.id,
      '❌ ' || public.meal_notice_title(v_ms) || ' cancelled', public.meal_notice_day(v_ms), v_ms.id);
  else
    perform public.notify_everyone_titled(p_kind, lower(p_kind) || ':' || v_ms.id,
      '🍽️ ' || public.meal_notice_title(v_ms), public.meal_notice_body(v_ms), v_ms.id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A regular meal's start: one plain notice with the menu as it is then
-- ---------------------------------------------------------------------------

alter table public.meal_services add column if not exists start_notified_at timestamptz;
-- Meals that already started don't announce themselves now.
update public.meal_services set start_notified_at = now()
where start_notified_at is null and service_start_at <= now();

create or replace function public.meal_start_notices() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  v_n integer := 0;
begin
  for v_ms in
    select * from public.meal_services
    where start_notified_at is null and service_start_at <= now()
    for update skip locked
  loop
    -- Only regular meals that are on and just started (a meal created long after its start stays quiet).
    if v_ms.state in ('SCHEDULED', 'IN_SERVICE') and not public.meal_is_special(v_ms.meal_type, v_ms.occasion)
       and v_ms.service_start_at > now() - interval '30 minutes' then
      perform public.announce_meal(v_ms.id, 'MEAL_START');
      v_n := v_n + 1;
    end if;
    update public.meal_services set start_notified_at = now() where id = v_ms.id;
  end loop;
  return v_n;
end $$;
revoke all on function public.meal_start_notices() from public, anon, authenticated;

create or replace function public.run_due_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return public.run_admission_jobs() || public.process_no_shows()
         || jsonb_build_object('rewards_given', public.settle_rsvps())
         || public.run_batch_jobs()
         || jsonb_build_object('events_closed', public.auto_close_events())
         || jsonb_build_object('meals_started', public.meal_start_notices());
end $$;

-- ---------------------------------------------------------------------------
-- Batches: only special meals tell everyone
-- ---------------------------------------------------------------------------

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
        public.meal_notice_title(v_ms) || ': batch ' || v_b.number || ' full',
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
        '🎟️ ' || public.meal_notice_title(v_ms) || ': booking open',
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
           jsonb_build_object('title', '🚪 ' || public.meal_notice_title(v_ms) || ': gate open',
                              'message', 'Batch ' || p_b.number || '. Booked students, come now.', 'url', '/', 'meal', v_ms.id)
    from public.profiles p
    where p.deleted_at is null and p.role::text <> 'VIEWER'
      and not exists (select 1 from public.batch_seats bs
                      where bs.batch_id = p_b.id and bs.user_id = p.id and bs.state = 'HOLDING')
    on conflict (event_key) do nothing;
  end if;
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;

-- ---------------------------------------------------------------------------
-- Editing a meal after its start
-- ---------------------------------------------------------------------------

create or replace function public.set_meal_details(
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
  v_before text;
  v_after text;
  v_now public.meal_services;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal service not found' using errcode = 'P0002';
  end if;
  -- Closed and cancelled meals can be corrected too (a spelling, a forgotten item, the name).
  v_before := public.meal_edit_fingerprint(v_ms.id);
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
  where id = p_meal_service_id
  returning * into v_now;

  -- Edited after its start: everyone is told (before the start, edits stay quiet).
  v_after := public.meal_edit_fingerprint(v_ms.id);
  if v_ms.service_start_at <= now() and v_after is distinct from v_before then
    perform public.notify_everyone_titled('MEAL_EDITED',
      'meal-edited:' || v_ms.id || ':' || extract(epoch from clock_timestamp())::bigint,
      '✏️ ' || public.meal_notice_title(v_now) || ' updated', public.meal_notice_body(v_now), v_ms.id);
  end if;
  perform public.write_audit('MEAL_DETAILS_SET', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('name', p_name, 'occasion', p_occasion, 'items', jsonb_array_length(coalesce(p_items, '[]'::jsonb))));
  return jsonb_build_object('status', 'OK', 'choices_kept', coalesce(v_restored, 0));
end $$;

-- A repeat of the same notice to the same person within 10 minutes is dropped (a double tap on Send,
-- saving a meal three times). Edits of one meal: only the first in 10 minutes goes out.
create or replace function public.outbox_skip_repeats() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.kind in ('MEAL_NEW', 'MEAL_START', 'MEAL_EDITED', 'MEAL_CANCELLED', 'ANNOUNCEMENT', 'ADMIN_MESSAGE',
                  'BOOKING_OPEN', 'GATE_OPEN', 'BATCH_FULL', 'BATCH_STARTED')
     and exists (select 1 from public.notification_outbox o
                 where o.recipient_id = new.recipient_id and o.kind = new.kind
                   and o.created_at > now() - interval '10 minutes'
                   and (o.payload = new.payload
                        or (new.kind = 'MEAL_EDITED' and o.payload ->> 'meal' is not distinct from new.payload ->> 'meal'))) then
    return null;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Dined, and the announcement
-- ---------------------------------------------------------------------------

create or replace function public.attendance_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_label text := (select public.meal_notice_label(m) from public.meal_services m where m.id = new.meal_service_id);
begin
  if tg_op = 'INSERT' and new.status = 'VALID' and new.holder_user_id is not null then
    perform public.enqueue_notification(new.holder_user_id, 'DINED', 'dined:' || new.id,
      jsonb_build_object('title', '✅ Dined', 'message', v_label, 'url', '/'));
  elsif tg_op = 'UPDATE' and old.status = 'VALID' and new.status = 'VOIDED' and new.holder_user_id is not null then
    perform public.enqueue_notification(new.holder_user_id, 'DINED_REMOVED', 'dined-removed:' || new.id,
      jsonb_build_object('title', 'Taken off dined', 'message', v_label, 'url', '/'));
  end if;
  return null;
end $$;

create or replace function public.post_announcement(p_body text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_id uuid;
  v_n integer;
begin
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then
    return jsonb_build_object('status', 'INVALID_MESSAGE');
  end if;
  insert into public.announcements (body, created_by) values (btrim(p_body), v_uid) returning id into v_id;
  v_n := public.notify_everyone('ANNOUNCEMENT', 'announcement:' || v_id, btrim(p_body), '/announcements');
  perform public.write_audit('ANNOUNCEMENT_POSTED', 'announcement', v_id::text, null, jsonb_build_object('sent_to', v_n));
  return jsonb_build_object('status', 'SENT', 'sent_to', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- Seat notices written by the booking functions: shortened as they are stored
-- (named so it runs before outbox_skip_repeats).
-- ---------------------------------------------------------------------------

create or replace function public.outbox_shorten() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m text := new.payload ->> 'message';
  r text[];
begin
  if new.payload ? 'title' or m is null then
    return new;
  end if;
  if new.kind = 'SEAT_BOOKED' then
    if m ~ '^You have a seat in batch' then
      r := regexp_match(m, 'batch (\d+)\. Be at the dining hall by (.+) and give coupon (\d+)');
      if r is not null then
        new.payload := new.payload || jsonb_build_object('title', '🎟️ Seat booked',
          'message', 'Batch ' || r[1] || ' · coupon ' || r[3] || ' · gate ' || r[2]);
      end if;
    elsif m ~ '^Lucky\?' then
      r := regexp_match(m, 'batch (\d+)');
      new.payload := new.payload || jsonb_build_object('title', '🍀 Lucky? place',
        'message', 'Batch ' || coalesce(r[1], '?') || ' · wait outside the gate');
    elsif m ~ '^Good news' then
      r := regexp_match(m, 'batch (\d+)\. Give coupon (\d+)');
      if r is not null then
        new.payload := new.payload || jsonb_build_object('title', '🎟️ Moved up to a seat',
          'message', 'Batch ' || r[1] || ' · coupon ' || r[2]);
      end if;
    elsif m ~ '^Dining is open' then
      r := regexp_match(m, 'coupon (\d+) at the door within (\d+) minutes');
      if r is not null then
        new.payload := new.payload || jsonb_build_object('title', '🍽️ Join now',
          'message', 'Coupon ' || r[1] || ' · within ' || r[2] || ' min');
      end if;
    end if;
  elsif new.kind = 'SEAT_RELEASED' then
    r := regexp_match(m, '^Batch (\d+) filled up');
    if r is not null then
      new.payload := new.payload || jsonb_build_object('title', 'Batch ' || r[1] || ' closed',
        'message', 'Not a missed meal. Book the next batch.');
    end if;
  elsif new.kind = 'COUPON_APPROVED' then
    r := regexp_match(m, '^Coupon (\d+) is confirmed');
    if r is not null then
      new.payload := new.payload || jsonb_build_object('title', '✅ Coupon confirmed', 'message', 'Coupon ' || r[1]);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists outbox_shorten on public.notification_outbox;
create trigger outbox_shorten before insert on public.notification_outbox
  for each row execute function public.outbox_shorten();
