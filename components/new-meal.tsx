'use client';

import { CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { MealEditor, emptyMealForm, mealFormFor, type QuickKind, itemsJson, saveMealExtras, toTimestamps } from '@/components/meal-editor';
import { Sheet } from '@/components/sheet';
import { dhakaToday } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { readKept } from '@/lib/use-load';

const OUTCOME: Record<string, string> = {
  EXISTS: 'That date already has this meal (one lunch and one dinner a day). Edit it from Dashboard → Meals, or choose Paron for an extra special meal.',
  END_BEFORE_START: 'The end time must be after the start.',
  BREAKFAST_NOT_USED: 'Breakfast is not used; use Paron for a special morning meal.',
};

/** Dishes from the meals on the Meals tab (kept on the phone), newest first, for one-tap adding. */
function recentDishes(): string[] {
  const meals = readKept<Array<{ menu?: string[] }>>('meals') ?? [];
  const seen = new Map<string, string>();
  for (const m of [...meals].reverse()) {
    for (const line of m.menu ?? []) {
      const name = line.replace(/ \(or .*\)$/, '').trim();
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()];
}

/** The + button's pop-up: a new meal in a few taps. */
export function NewMealSheet({ onClose, onCreated, type }: {
  onClose: () => void; onCreated?: () => void;
  /** Start the form on this meal (the Dashboard's Lunch + / Dinner + / Improvement + / Feast +). */ type?: QuickKind;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [suggestions] = useState(recentDishes);

  return (
    <Sheet title="New meal" onClose={onClose} bare>
      {done ? (
        <div className="grid justify-items-center gap-3 py-6 text-center">
          <CircleCheck size={44} className="text-ok" />
          <p className="text-base font-semibold">Meal created</p>
          <p className="text-sm text-muted">{done}</p>
          <button onClick={onClose} className="mt-2 rounded-xl bg-accent px-5 py-2.5 font-medium text-accent-fg">OK</button>
        </div>
      ) : (
        <>
          {error && <p className="mb-3 rounded-xl bg-bad-soft px-3 py-2 text-sm text-bad" role="alert">{error}</p>}
          <MealEditor mode="create" busy={busy} initial={type ? mealFormFor(dhakaToday(), type) : emptyMealForm(dhakaToday())} suggestions={suggestions}
            onSubmit={async (f) => {
              setBusy(true);
              setError(null);
              try {
                const t = toTimestamps(f);
                const r = await rpc<{ status: string; meal_service_id?: string; details?: { status?: string } }>('create_meal_event', {
                  p_service_date: f.date, p_meal_type: f.mealType, p_start_at: t.start, p_end_at: t.end,
                  p_name: f.name, p_occasion: f.occasion, p_description: f.description, p_items: itemsJson(f.items), p_policy_version: null,
                });
                if (r.status !== 'CREATED' || !r.meal_service_id) { setError(OUTCOME[r.status] ?? r.status.replaceAll('_', ' ').toLowerCase()); return; }
                const warn = await saveMealExtras(r.meal_service_id, f);
                onCreated?.();
                // Created: the sheet just closes (the meal shows up where it was added). Only a problem with
                // the extras (poster, notice) is worth a word.
                if (warn) setDone(warn); else onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }} />
        </>
      )}
    </Sheet>
  );
}
