'use client';

import { useState } from 'react';
import { ConfirmButton } from '@/components/admin-shell';
import { type Batch } from '@/components/meal-booking';
import { MealEditor, itemsJson, saveMealExtras, toTimestamps, type MealForm } from '@/components/meal-editor';
import { Sheet } from '@/components/sheet';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

/** A meal as the managers' list (admin_meal_services) returns it. */
export type Meal = {
  id: string; service_date: string; meal_type: string; service_start_at: string; service_end_at: string | null; state: string;
  policy_version: number; invitations_paused: boolean; name: string | null; occasion: string; description: string | null;
  special: boolean; items: Array<{ name: string; alternatives: string[] }>; choices_close_at: string | null;
  live_waves: Array<{ aisle: string; wave_number: number; phase: string }>;
  confirmed: number; standby: number; diners: number;
  batch_capacity: number; notice: string | null; poster_url: string | null; booking_open_minutes: number; arrival_minutes: number; seats: number; missed: number; batch: Batch | null;
};

export const hhmm = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)) : '';

export const menuOf = (m: Meal) => m.items.map((i) => (i.alternatives.length ? `${i.name} (or ${i.alternatives.join(' / ')})` : i.name));

export const formFor = (m: Meal): MealForm => ({
  date: m.service_date, mealType: m.meal_type as MealForm['mealType'], occasion: m.occasion as MealForm['occasion'],
  name: m.name ?? '', start: hhmm(m.service_start_at), end: hhmm(m.service_end_at), description: m.description ?? '',
  items: m.items.map((i) => ({ name: i.name, alternatives: i.alternatives.join(', ') })),
  choicesClose: m.choices_close_at ? dhakaLocal(m.choices_close_at) : '',
  seats: String(m.batch_capacity),
  notice: m.notice ?? '', poster: m.poster_url ?? '',
  bookingOpen: String(m.booking_open_minutes ?? 15), arrive: '5',
});

/** "2026-11-07T12:00" in Dhaka time, for a datetime-local input. */
function dhakaLocal(iso: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

/** Save the edited details (name, end, dishes) and then the extras (seats, notice, poster). Returns a problem, or null. */
export async function saveMeal(m: Meal, f: MealForm): Promise<string | null> {
  const t = toTimestamps({ ...f, date: m.service_date, start: hhmm(m.service_start_at) });
  const r = await rpc<{ status: string }>('set_meal_details', {
    p_meal_service_id: m.id, p_name: f.name, p_occasion: f.occasion, p_description: f.description,
    p_end_at: t.end, p_items: itemsJson(f.items),
  });
  if (r.status !== 'OK') return r.status === 'MEAL_CLOSED' ? 'That meal is closed and can no longer be edited.' : r.status.replaceAll('_', ' ').toLowerCase();
  return saveMealExtras(m.id, f);
}

/**
 * The Dashboard's Edit: the meal's editor in a pop-up, with Delete at the bottom left (tap, then "Sure?").
 * The meal's full details are asked for only when the pop-up opens.
 */
export function EditMealSheet({ mealId, onClose, onChanged }: { mealId: string; onClose: () => void; onChanged: () => void }) {
  const { data, error } = useLoad(() => rpc<{ meals: Meal[] }>('admin_meal_services', { p_limit: 30 }));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const meal = data?.meals.find((m) => m.id === mealId);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setMsg(null);
    try {
      const problem = await fn();
      if (problem) setMsg(problem); else { onChanged(); onClose(); }
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Edit meal" onClose={onClose} bare>
      {msg && <p className="mb-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">{msg}</p>}
      {meal ? (
        <MealEditor mode="edit" inSheet busy={busy} initial={formFor(meal)} onSubmit={(f) => run(() => saveMeal(meal, f))}
          footer={(
            <ConfirmButton variant="danger" disabled={busy}
              onConfirm={() => run(async () => {
                const r = await rpc<{ status: string }>('delete_meal', { p_meal_service_id: meal.id, p_confirm: 'DELETE' });
                return r.status === 'DELETED' ? null : r.status.replaceAll('_', ' ').toLowerCase();
              })}>
              Delete
            </ConfirmButton>
          )} />
      ) : (
        <p className="py-8 text-center text-sm text-muted">{error ?? (data ? 'That meal is no longer in the list.' : 'Loading…')}</p>
      )}
    </Sheet>
  );
}
