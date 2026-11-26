-- (Renumbered from 20261107000300 so it runs after the lucky-seats updates; safe to run again.)
-- Admins can correct any meal, even closed or cancelled ones (name, food items, spelling), and
-- delete a meal entirely. Changing the name or food of a meal that already happened tells everyone.
-- Each student is told when they are marked as having eaten a meal, or taken off it.

-- What students see of a meal's identity: its name and its menu.
create or replace function public.meal_edit_fingerprint(p_meal_service_id uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(m.name, '') || '|' || coalesce((select string_agg(x, '·') from jsonb_array_elements_text(public.meal_brief(m) -> 'menu') x), '')
  from public.meal_services m where m.id = p_meal_service_id
$$;

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
  where id = p_meal_service_id;

  -- A meal that already happened: everyone is told what changed (future meals: edits stay quiet).
  v_after := public.meal_edit_fingerprint(v_ms.id);
  if v_ms.service_start_at <= now() and v_after is distinct from v_before then
    perform public.notify_everyone('MEAL_EDITED', 'meal-edited:' || v_ms.id || ':' || extract(epoch from clock_timestamp())::bigint,
      'Updated: ' || public.meal_notice_label((select m from public.meal_services m where m.id = v_ms.id))
        || coalesce('. Menu: ' || (select string_agg(x, ' · ') from jsonb_array_elements_text(
             public.meal_brief((select m from public.meal_services m where m.id = v_ms.id)) -> 'menu') x), '') || '.',
      '/events/' || v_ms.id);
  end if;
  perform public.write_audit('MEAL_DETAILS_SET', 'meal_service', p_meal_service_id::text, null,
    jsonb_build_object('name', p_name, 'occasion', p_occasion, 'items', jsonb_array_length(coalesce(p_items, '[]'::jsonb))));
  return jsonb_build_object('status', 'OK', 'choices_kept', coalesce(v_restored, 0));
end $$;

-- "You're marked as dined" / "taken off" for the student whose coupon it is.
create or replace function public.attendance_notice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_label text := (select public.meal_notice_label(m) from public.meal_services m where m.id = new.meal_service_id);
begin
  if tg_op = 'INSERT' and new.status = 'VALID' and new.holder_user_id is not null then
    perform public.enqueue_notification(new.holder_user_id, 'DINED', 'dined:' || new.id,
      jsonb_build_object('message', 'You are marked as dined: ' || v_label || '.', 'url', '/me/profile'));
  elsif tg_op = 'UPDATE' and old.status = 'VALID' and new.status = 'VOIDED' and new.holder_user_id is not null then
    perform public.enqueue_notification(new.holder_user_id, 'DINED_REMOVED', 'dined-removed:' || new.id,
      jsonb_build_object('message', 'You were taken off the dined list for ' || v_label || '.', 'url', '/me/profile'));
  end if;
  return null;
end $$;
drop trigger if exists attendance_notice on public.attendance_records;
create trigger attendance_notice after insert or update of status on public.attendance_records
  for each row execute function public.attendance_notice();

-- Delete a meal and everything recorded for it. The admin types the meal's name (or DELETE) to confirm.
create or replace function public.delete_meal(p_meal_service_id uuid, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_ms public.meal_services;
  m uuid;
begin
  select * into v_ms from public.meal_services where id = p_meal_service_id for update;
  if not found then
    raise exception 'meal not found' using errcode = 'P0002';
  end if;
  if upper(btrim(coalesce(p_confirm, ''))) not in ('DELETE', upper(btrim(coalesce(v_ms.name, '')))) or btrim(coalesce(p_confirm, '')) = '' then
    return jsonb_build_object('status', 'NOT_CONFIRMED');
  end if;
  m := v_ms.id;
  perform public.write_audit('MEAL_DELETED', 'meal_service', m::text,
    jsonb_build_object('name', v_ms.name, 'meal_type', v_ms.meal_type, 'start', v_ms.service_start_at,
                       'ate', (select count(*) from public.attendance_records a where a.meal_service_id = m and a.status = 'VALID')), null);

  alter table public.attendance_records disable trigger attendance_records_guard;
  alter table public.no_show_events disable trigger no_show_events_guard;
  alter table public.points_ledger disable trigger points_ledger_append_only;
  alter table public.penalty_events disable trigger penalty_events_no_delete;
  alter table public.no_show_appeals disable trigger no_show_appeals_no_delete;

  update public.no_show_events set reversed_by_attendance_id = null
    where reversed_by_attendance_id in (select id from public.attendance_records where meal_service_id = m);
  update public.penalty_events set consumed_meal_service_id = null where consumed_meal_service_id = m;
  delete from public.no_show_appeals where no_show_event_id in (select id from public.no_show_events where meal_service_id = m);
  delete from public.penalty_events where no_show_event_id in (select id from public.no_show_events where meal_service_id = m);
  delete from public.no_show_events where meal_service_id = m;
  delete from public.batch_seats where meal_service_id = m;
  delete from public.meal_batches where meal_service_id = m;
  delete from public.points_ledger where meal_service_id = m;
  delete from public.rsvp_change_requests where meal_service_id = m;
  delete from public.meal_rsvps where meal_service_id = m;
  delete from public.meal_coming where meal_service_id = m;
  delete from public.meal_ratings where meal_service_id = m;
  delete from public.attendance_records where meal_service_id = m;
  delete from public.menu_items where meal_service_id = m;
  delete from public.manager_ratings where meal_service_id = m;
  delete from public.feedback where meal_service_id = m;
  delete from public.standby_offers where meal_service_id = m;
  delete from public.reservations where meal_service_id = m;
  delete from public.booking_participations where meal_service_id = m;
  delete from public.coupon_collection_rounds where meal_service_id = m;
  update public.aisles set current_wave_id = null
    where current_wave_id in (select id from public.aisle_waves where meal_service_id = m);
  delete from public.aisle_waves where meal_service_id = m;
  delete from public.meal_services where id = m;

  alter table public.attendance_records enable trigger attendance_records_guard;
  alter table public.no_show_events enable trigger no_show_events_guard;
  alter table public.points_ledger enable trigger points_ledger_append_only;
  alter table public.penalty_events enable trigger penalty_events_no_delete;
  alter table public.no_show_appeals enable trigger no_show_appeals_no_delete;
  return jsonb_build_object('status', 'DELETED');
end $$;

grant execute on function public.delete_meal(uuid, text) to authenticated;
