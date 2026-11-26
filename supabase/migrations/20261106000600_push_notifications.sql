-- Notifications that reach phones (web push), not only the bell:
-- * every notification already written for a person (claims, roommates, messages...) is pushed;
-- * everyone hears: a new meal (with its menu), a cancelled meal, "booking open" for each batch,
--   "gate open", "batch full", and admins' announcements.
-- Phones register a push subscription; the app's push sender (/api/push) delivers the outbox.
-- Live, a new outbox row wakes the sender through pg_net, if the push settings are stored
-- in public.app_settings (kept out of the code: see docs/GOING_LIVE.md).

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id),
  endpoint text not null unique check (char_length(endpoint) <= 2000),
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;

create table public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

alter table public.meal_batches
  add column booking_notified_at timestamptz,
  add column full_notified_at timestamptz;
-- Batches that already opened don't announce themselves now.
update public.meal_batches set booking_notified_at = now() where booking_opens_at <= now();

-- "Improvement-11 · Thu 6 Nov, 08:30 pm"
create function public.meal_notice_label(p_ms public.meal_services) returns text
language sql stable as $$
  select coalesce(nullif(p_ms.name, ''), initcap(p_ms.meal_type::text)) || ' · '
         || to_char(p_ms.service_start_at at time zone 'Asia/Dhaka', 'Dy DD Mon, HH12:MI am')
$$;

-- One notification for every active account (students and staff; not view-only accounts).
create function public.notify_everyone(p_kind text, p_key text, p_message text, p_url text default '/me') returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_n integer;
begin
  insert into public.notification_outbox (recipient_id, kind, event_key, payload)
  select p.id, p_kind, p_key || ':' || p.id, jsonb_build_object('message', p_message, 'url', p_url)
  from public.profiles p
  where p.deleted_at is null and p.role::text <> 'VIEWER'
  on conflict (event_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function public.announce_meal(p_meal_service_id uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  v_menu text;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id;
  select string_agg(x, ' · ') into v_menu from jsonb_array_elements_text(public.meal_brief(v_ms) -> 'menu') x;
  perform public.notify_everyone(p_kind, lower(p_kind) || ':' || v_ms.id,
    case p_kind when 'MEAL_CANCELLED' then 'Cancelled: ' || public.meal_notice_label(v_ms) || '.'
         else 'New: ' || public.meal_notice_label(v_ms) || coalesce('. Menu: ' || v_menu, '') || '.' end,
    '/events/' || v_ms.id);
end $$;

-- A cancelled meal is announced too.
create function public.meal_cancel_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.state = 'CANCELLED' and old.state is distinct from 'CANCELLED' and new.service_start_at > now() - interval '6 hours' then
    perform public.announce_meal(new.id, 'MEAL_CANCELLED');
  end if;
  return null;
end $$;
create trigger meal_cancel_notice after update of state on public.meal_services
  for each row execute function public.meal_cancel_notice();

-- "Batch N is full" once, when the last seat is taken.
create function public.batch_full_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b public.meal_batches;
begin
  select * into v_b from public.meal_batches where id = new.batch_id;
  if v_b.full_notified_at is null and v_b.loaded_at is null and new.kind <> 'WALK_IN'
     and public.batch_taken(v_b) >= v_b.capacity then
    update public.meal_batches set full_notified_at = now() where id = v_b.id;
    perform public.notify_everyone('BATCH_FULL', 'batch-full:' || v_b.id,
      (select public.meal_notice_label(ms) from public.meal_services ms where ms.id = v_b.meal_service_id)
        || ': batch ' || v_b.number || ' is full. Booking for batch ' || (v_b.number + 1) || ' opens after it is filled.', '/me');
  end if;
  return null;
end $$;
create trigger batch_full_notice after insert on public.batch_seats
  for each row execute function public.batch_full_notice();

create or replace function public.create_meal_event(
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
  -- Everyone hears about a new meal (not about later edits).
  if p_start_at > now() then
    perform public.announce_meal((v_r ->> 'meal_service_id')::uuid, 'MEAL_NEW');
  end if;
  return v_r || jsonb_build_object('details', v_d);
end $$;

create or replace function public.run_batch_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b public.meal_batches;
  s record;
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

  -- "Booking open" for each batch once its booking opens (batch 1 at its time, later ones on the staff's press).
  for b in
    select mb.* from public.meal_batches mb join public.meal_services ms on ms.id = mb.meal_service_id
    where mb.booking_notified_at is null and mb.loaded_at is null and mb.booking_opens_at <= now()
      and mb.booking_opens_at > now() - interval '30 minutes' and ms.state in ('SCHEDULED', 'IN_SERVICE')
    for update of mb skip locked
  loop
    perform public.notify_everyone('BOOKING_OPEN', 'booking-open:' || b.id,
      (select public.meal_notice_label(ms) from public.meal_services ms where ms.id = b.meal_service_id)
        || ': booking for batch ' || b.number || ' is open (' || b.capacity || ' seats)'
        || coalesce('. Gate opens ' || to_char(b.starts_at at time zone 'Asia/Dhaka', 'HH12:MI am'), '') || '. Book now in the app.',
      '/me');
    update public.meal_batches set booking_notified_at = now() where id = b.id;
  end loop;
  return jsonb_build_object('batches_started', v_started, 'seats_released', v_released);
end $$;

create or replace function public.batch_start_notices(p_b public.meal_batches) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.batch_seats;
begin
  for s in select * from public.batch_seats where batch_id = p_b.id and state = 'HOLDING' and user_id is not null loop
    perform public.enqueue_notification(s.user_id, 'BATCH_STARTED', 'batch-start:' || s.id,
      jsonb_build_object('message', 'Batch ' || p_b.number || ' gate is open. Come to the dining hall now and give coupon '
        || s.coupon_number || ' at the door. Your timer has started.'));
  end loop;
  perform public.notify_everyone('GATE_OPEN', 'gate-open:' || p_b.id,
    (select public.meal_notice_label(ms) from public.meal_services ms where ms.id = p_b.meal_service_id)
      || ': batch ' || p_b.number || ' gate is open. Booked students, come now.', '/me');
  update public.meal_batches set start_notified_at = now() where id = p_b.id;
end $$;

-- Admins' announcements: kept, and sent to everyone.
create function public.post_announcement(p_body text) returns jsonb
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
  v_n := public.notify_everyone('ANNOUNCEMENT', 'announcement:' || v_id, btrim(p_body), '/me');
  perform public.write_audit('ANNOUNCEMENT_POSTED', 'announcement', v_id::text, null, jsonb_build_object('sent_to', v_n));
  return jsonb_build_object('status', 'SENT', 'sent_to', v_n);
end $$;

create function public.list_announcements(p_limit integer default 30) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'created_at', a.created_at,
                                               'by', (select full_name from public.profiles where id = a.created_by))
                            order by a.created_at desc), '[]'::jsonb)
  from (select * from public.announcements order by created_at desc limit least(greatest(p_limit, 1), 100)) a,
       (select public.require_role('VIEWER')) u
$$;

-- This phone/browser wants notifications for the signed-in account.
create function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('VIEWER');
begin
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    return jsonb_build_object('status', 'INVALID');
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (v_uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth;
  return jsonb_build_object('status', 'OK');
end $$;

create function public.remove_push_subscription(p_endpoint text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('VIEWER');
begin
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = v_uid;
  return jsonb_build_object('status', 'OK');
end $$;

-- Wake the push sender after new notifications (live only: needs pg_net and the stored settings).
create function public.push_kick() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_url text := (select value from public.app_settings where key = 'push_dispatch_url');
  v_secret text := (select value from public.app_settings where key = 'push_dispatch_secret');
begin
  if v_url is not null and v_secret is not null and to_regnamespace('net') is not null then
    execute 'select net.http_post(url := $1, headers := $2, body := $3)'
      using v_url, jsonb_build_object('content-type', 'application/json', 'x-push-secret', v_secret), '{}'::jsonb;
  end if;
  return null;
end $$;
create trigger notification_outbox_push after insert on public.notification_outbox
  for each statement execute function public.push_kick();

grant execute on function
  public.post_announcement(text),
  public.list_announcements(integer),
  public.save_push_subscription(text, text, text),
  public.remove_push_subscription(text)
to authenticated;
