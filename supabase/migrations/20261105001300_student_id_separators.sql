-- Student IDs are compared and stored without spaces, dashes or slashes, so
-- "2021-331-024" on a card and "2021331024" on the hall's list are the same ID.

create or replace function public.normalize_student_id(p_value text) returns text
language sql immutable as $$
  select case when upper(regexp_replace(coalesce(p_value, ''), '[[:space:]/-]', '', 'g')) ~ '^[A-Z0-9]{3,24}$'
              then upper(regexp_replace(p_value, '[[:space:]/-]', '', 'g')) end
$$;

update public.profiles set student_id = public.normalize_student_id(student_id)
where student_id is not null and student_id is distinct from public.normalize_student_id(student_id);
update public.coupon_claims set claimed_student_id = public.normalize_student_id(claimed_student_id)
where claimed_student_id is not null and claimed_student_id is distinct from public.normalize_student_id(claimed_student_id);
