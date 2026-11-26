-- Every meal closes by itself 12 hours after it ends (2026-11-18), if nobody closed it: a lunch that ends
-- at 2:30 pm closes at 2:30 am. A meal with no end time counts from its start. Replaces the earlier rule
-- (only improvements, feasts and parons, 10 hours after the start); lunch and dinner no longer stay open
-- until a manager closes them. An open batch just ends, without missed meals, as before.

create or replace function public.auto_close_events() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ms public.meal_services;
  b public.meal_batches;
  v_n integer := 0;
begin
  for v_ms in
    select * from public.meal_services
    where state in ('SCHEDULED', 'IN_SERVICE')
      and coalesce(service_end_at, service_start_at) < now() - interval '12 hours'
    for update skip locked
  loop
    -- No missed meals: nobody pressed "Filled" (spec 1.3), so the open batch just ends.
    for b in select * from public.meal_batches where meal_service_id = v_ms.id and loaded_at is null for update loop
      perform public.close_batch(b, false, false);
    end loop;
    update public.meal_services set state = 'CLOSED', state_changed_at = now() where id = v_ms.id;
    perform public.write_audit('MEAL_SERVICE_STATE_CHANGED', 'meal_service', v_ms.id::text,
      jsonb_build_object('state', v_ms.state), jsonb_build_object('state', 'CLOSED'), 'Closed by itself 12 hours after the end');
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.auto_close_events() from public, anon, authenticated;
