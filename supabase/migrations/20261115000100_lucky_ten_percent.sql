-- Amendment 1.6 (decided 2026-11-15): Lucky? places are 10% of a batch's seats, rounded down
-- (50 → 5, 60 → 6, 9 → 0). Everything else about Lucky? places is unchanged.

create or replace function public.batch_lucky_capacity(p_b public.meal_batches) returns integer
language sql immutable as $$
  select floor(coalesce(p_b.capacity, 0) * 0.1)::integer
$$;
