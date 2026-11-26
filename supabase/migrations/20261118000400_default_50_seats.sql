-- Seats per batch start at 50 (2026-11-18); the mess manager can change it for each meal.
-- Only new meals: meals already created keep the number they have.
alter table public.meal_services alter column batch_capacity set default 50;
