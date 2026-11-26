'use client';

import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AdminShell, Empty, Notice } from '@/components/admin-shell';
import { Button, Sheet } from '@/components/sheet';
import { dhakaDate, mealName, timeRange, titleCase } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Meal = {
  id: string; meal_type: string; name: string | null; occasion: string; special: boolean; state: string;
  service_start_at: string; service_end_at: string | null; diners: number; items: Array<{ name: string; alternatives: string[] }>;
};
type Sheet_ = {
  meal: { id: string; meal_type: string; service_start_at: string };
  people: Array<{ coupon_number: number; user_id: string | null; name: string | null; has_account: boolean; avatar_url: string | null; room: string | null; ate: boolean; not_coming: boolean }>;
};

export default function AttendancePage() {
  return <AdminShell active="attendance">{() => <Attendance />}</AdminShell>;
}

/** Lunch and dinner attendance, the traditional way: after the meal, tick who ate. */
function Attendance() {
  const { data, reload } = useLoad(() => rpc<{ meals: Meal[] }>('admin_meal_services', { p_limit: 60 }));
  const [open, setOpen] = useState<Meal | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (!data) return <Empty>Loading…</Empty>;
  const meals = data.meals.filter((m) => m.state !== 'CANCELLED' && new Date(m.service_start_at).getTime() <= Date.now());

  return (
    <>
      <Notice text={note} />
      {meals.length === 0 ? <Empty>No lunch or dinner has started yet.</Empty> : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {meals.map((m) => (
            <li key={m.id}>
              <button onClick={() => setOpen(m)} className="card flex w-full items-center gap-3 text-left transition hover:-translate-y-0.5 hover:shadow-lg">
                <span className="flex w-14 shrink-0 flex-col items-center rounded-xl bg-accent-soft py-1.5 text-accent">
                  <span className="text-lg font-semibold leading-none">{dhakaDate(m.service_start_at).split(' ')[0]}</span>
                  <span className="text-[0.6875rem] uppercase">{dhakaDate(m.service_start_at).split(' ')[1]}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold">{m.special && m.name ? m.name : mealName(m.meal_type)} <span className="font-normal text-muted">· {timeRange(m.service_start_at)}</span></span>
                  <span className="block truncate text-sm text-muted">{m.items.map((i) => i.name).join(' · ') || 'No menu'}</span>
                </span>
                <span className="text-right">
                  <span className="block text-xl font-semibold tabular-nums">{m.diners}</span>
                  <span className="block text-xs text-muted">ate</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <TickSheet meal={open} onClose={() => setOpen(null)} onSaved={(n) => { setNote(n); setOpen(null); reload(); }} />
      )}
    </>
  );
}

const PAGE = 100;   // coupons per page, as a 10 × 10 grid

/**
 * Coupon tiles, 100 to a page (1–100, 101–200, …), each tapped to tick or untick.
 * Every coupon in the hall register can be ticked, account or not: a coupon without an account yet has a
 * dashed outline, and its meals become the student's when they claim it. Numbers not in the register are faded.
 */
function TickSheet({ meal, onClose, onSaved }: { meal: Meal; onClose: () => void; onSaved: (note: string) => void }) {
  const { data } = useLoad(() => rpc<Sheet_>('meal_attendance_sheet', { p_meal_service_id: meal.id }));
  const [ticked, setTicked] = useState<Set<number> | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const set = ticked ?? new Set((data?.people ?? []).filter((p) => p.ate).map((p) => p.coupon_number));
  const holders = useMemo(() => new Map((data?.people ?? []).map((p) => [p.coupon_number, p])), [data]);
  const pages = Math.max(1, Math.ceil(Math.max(0, ...holders.keys()) / PAGE));
  const first = page * PAGE + 1;

  const toggle = (c: number) => { const n = new Set(set); if (n.has(c)) n.delete(c); else n.add(c); setTicked(n); };
  const save = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string; present?: number }>('set_meal_attendance', { p_meal_service_id: meal.id, p_coupon_numbers: [...set] });
      onSaved(r.status === 'OK' ? `${mealName(meal.meal_type)}, ${dhakaDate(meal.service_start_at)}: ${r.present} ate.` : r.status);
    } catch (e) {
      onSaved((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet wide title={`${mealName(meal.meal_type)} · ${dhakaDate(meal.service_start_at)}`} onClose={onClose}>
      {!data ? <Empty>Loading…</Empty> : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p><b className="tabular-nums">{set.size}</b> <span className="text-muted">ticked</span></p>
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <span className="inline-block size-3.5 rounded border border-dashed border-muted/60" /> no account yet: tick anyway
            </p>
          </div>
          <PasteTicks onTick={(nums) => {
            const known = nums.filter((n) => holders.has(n));
            const n = new Set(set); known.forEach((c) => n.add(c)); setTicked(n);
            const unknown = nums.filter((x) => !holders.has(x));
            return `${known.length} ticked${unknown.length ? ` · not in the register: ${unknown.join(', ')}` : ''}`;
          }} />
          <div className="mx-auto grid w-full max-w-[calc(90dvh-13rem)] grid-cols-10 gap-1 sm:gap-1.5">
            {Array.from({ length: PAGE }, (_, i) => first + i).map((c) => {
              const p = holders.get(c);
              const on = set.has(c);
              return (
                <button key={c} disabled={!p} onClick={() => toggle(c)} aria-pressed={on}
                  title={!p ? 'Not in the hall register' : `${titleCase(p.name) ?? 'Coupon ' + c}${p.has_account ? '' : ' · no account yet'}`}
                  className={`aspect-square rounded-lg text-xs font-semibold tabular-nums transition sm:text-sm ${
                    !p ? 'text-muted/40'
                      : on ? 'bg-accent text-accent-fg'
                      : p.has_account ? 'bg-subtle hover:ring-2 hover:ring-accent'
                      : 'border border-dashed border-muted/60 hover:ring-2 hover:ring-accent'}`}>
                  {c}
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button disabled={page === 0} onClick={() => setPage(page - 1)}>
              <span className="flex items-center gap-1"><ChevronLeft size={16} /> Back</span>
            </Button>
            <span className="text-sm text-muted tabular-nums">{first}–{first + PAGE - 1}</span>
            <Button disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              <span className="flex items-center gap-1">Next <ChevronRight size={16} /></span>
            </Button>
          </div>
          <Button variant="primary" disabled={busy} onClick={save}>
            <span className="flex items-center justify-center gap-2"><Check size={18} /> Done</span>
          </Button>
        </div>
      )}
    </Sheet>
  );
}

/** Paste or type a list like {1,2,3,4,5,6} (any separators) and tick them all at once. */
function PasteTicks({ onTick }: { onTick: (nums: number[]) => string }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const nums = [...new Set((text.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0))];
  return (
    <form className="grid gap-1.5" onSubmit={(e) => { e.preventDefault(); if (nums.length) { setMsg(onTick(nums)); setText(''); } }}>
      <div className="flex gap-2">
        <input value={text} onChange={(e) => { setText(e.target.value); setMsg(null); }} className="input min-w-0 flex-1 font-mono"
          placeholder="{1,2,3,4,5,6}" aria-label="Coupon numbers to tick, like {1,2,3}" inputMode="text" />
        <Button type="submit" variant="primary" disabled={!nums.length}>Tick {nums.length || ''}</Button>
      </div>
      {msg && <p className="text-xs text-muted" role="status">{msg}</p>}
    </form>
  );
}
