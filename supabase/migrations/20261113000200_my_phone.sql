-- Everyone can add, change or remove their own phone number (optional; shown on their profile and
-- to the mess managers). Sign-in does not use it.

create function public.set_my_phone(p_phone text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('STUDENT');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
begin
  if v_phone is not null then
    if v_phone ~ '^8801' then v_phone := substr(v_phone, 3); end if;
    if v_phone !~ '^01[3-9][0-9]{8}$' then
      return jsonb_build_object('status', 'INVALID_PHONE');
    end if;
  end if;
  update public.profiles set notify_phone = v_phone, updated_at = now() where id = v_uid;
  return jsonb_build_object('status', 'OK', 'phone', v_phone);
end $$;
revoke all on function public.set_my_phone(text) from public, anon;
grant execute on function public.set_my_phone(text) to authenticated;
