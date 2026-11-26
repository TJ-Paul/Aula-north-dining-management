'use client';

import { Check, Users } from 'lucide-react';
import { useState } from 'react';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Info = { count: number; mine: boolean };

/**
 * Paron: few students join, so they say "I'm coming"; everyone sees how many are.
 * Loaded once, a few seconds after the screen opens (not polled: every open phone would otherwise ask
 * for every upcoming paron twice a minute), and again after the student's own tap.
 */
export function Coming({ mealId, open }: { mealId: string; open: boolean }) {
  const { data, reload } = useLoad(() => rpc<Info>('meal_coming_info', { p_meal_service_id: mealId }), undefined,
    { lazy: true, cache: `coming-${mealId}` });
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const flip = async () => {
    setBusy(true);
    try { await rpc('set_coming', { p_meal_service_id: mealId, p_coming: !data.mine }); await reload(); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
      <span className="flex items-center gap-2 text-sm text-muted"><Users size={16} /> <b className="text-fg tabular-nums">{data.count}</b> coming</span>
      {open && (
        <button onClick={flip} disabled={busy} aria-pressed={data.mine}
          className={`flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-medium transition ${data.mine
            ? 'bg-accent text-accent-fg' : 'border border-border hover:border-accent hover:text-accent'}`}>
          {data.mine && <Check size={16} />} {data.mine ? 'I’m coming' : 'I’m coming?'}
        </button>
      )}
    </div>
  );
}

/** The managers' count for a paron. */
export function ComingCount({ mealId }: { mealId: string }) {
  const { data } = useLoad(() => rpc<Info>('meal_coming_info', { p_meal_service_id: mealId }), 30000);
  return data ? <span>{data.count} coming</span> : null;
}
