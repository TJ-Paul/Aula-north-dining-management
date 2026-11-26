-- Admins and super admins change their own name straight away (students and staff still ask an admin).

create function public.set_my_name(p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := public.require_role('ADMIN');
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_old text;
begin
  if char_length(v_name) not between 2 and 80 then
    return jsonb_build_object('status', 'INVALID_NAME');
  end if;
  select full_name into v_old from public.profiles where id = v_uid;
  update public.profiles set full_name = v_name, updated_at = now() where id = v_uid;
  update public.name_change_requests set status = 'WITHDRAWN', decided_at = now()
  where user_id = v_uid and status = 'PENDING';
  perform public.write_audit('NAME_CHANGED', 'profile', v_uid::text,
    jsonb_build_object('name', v_old), jsonb_build_object('name', v_name));
  return jsonb_build_object('status', 'OK', 'name', v_name);
end $$;

grant execute on function public.set_my_name(text) to authenticated;
