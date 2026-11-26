'use client';

import { ChevronDown, CircleCheck, CircleX, Clock, DoorOpen, Lock, Ticket, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ConfirmButton } from '@/components/admin-shell';
import { BatchClock, SeatBar, type Batch } from '@/components/meal-booking';
import { mealLabel } from '@/components/meal-card';
import { countdown, timeRange, titleCase } from '@/lib/format';
import { NetworkError, rpc } from '@/lib/rpc';
import { pollWhileVisible } from '@/lib/poll';

type MealRef = { id: string; name: string | null; meal_type: string; occasion: string; service_start_at: string; state: string };
type Person = { seat_id: string; coupon_number: number; name: string | null; kind: string };
export type Board = {
  meals: MealRef[]; meal: MealRef | null; batch: Batch | null;
  expected: Array<Person & { deadline: string | null; lapsed: boolean }>;
  arrivals: Array<Person & { arrived_at: string }>;
  history: Array<{ number: number; starts_at: string | null; loaded_at: string; arrived: number; missed: number }>;
  previous: { number: number; starts_at: string | null; loaded_at: string; arrived: number; missed: number; capacity: number } | null;
  next_capacity: number;
};
type Tone = 'ok' | 'warn' | 'bad' | 'info';
type Result = { tone: Tone; title: string; detail?: string };
const TONE: Record<Tone, string> = {
  ok: 'border-ok bg-ok-soft', warn: 'border-warn bg-warn-soft', bad: 'border-bad bg-bad-soft', info: 'border-border bg-subtle',
};

/** Gate controls appear this long before an event starts (an 8:30 pm improvement: from 7:30 pm). */
export const CONTROL_LEAD_MS = 60 * 60000;

/**
 * The gate for today's improvement, feast or paron, straight on the dashboard: the live stopwatch,
 * seats booked, who came in and who is still to come, and the three batch actions in a loop:
 * Filled → Start taking bookings (how many) → Gate open → Filled …
 * The rules are the door's (load_batch, open_next_booking, start_next_batch); only the place changed.
 * Until an hour before the start it shows when the controls will appear.
 */
export function GateControl({ onLive }: {
  /** Told whether the gate controls are showing now (an event within the hour or under way). */ onLive?: (live: boolean) => void;
} = {}) {
  const [mealId, setMealId] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lists, setLists] = useState(false);

  const meal = board?.meal ?? null;
  const near = !!meal && now >= new Date(meal.service_start_at).getTime() - CONTROL_LEAD_MS;
  useEffect(() => { onLive?.(near); }, [near, onLive]);

  const load = useCallback(async () => {
    try {
      setBoard(await rpc<Board>('door_board', { p_meal_service_id: mealId }));
      setError(null);
    } catch (e) {
      setError(e instanceof NetworkError ? 'No connection. Showing the last known state.' : (e as Error).message);
    }
  }, [mealId]);

  // Every 3 s while the gate matters; once a minute while the event is still hours away.
  useEffect(() => {
    load();
    const stop = pollWhileVisible(load, near ? 3000 : 60000);
    return stop;
  }, [load, near]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const act = async (fn: string, args: Record<string, unknown>, ok: (r: Record<string, unknown>) => Result) => {
    setBusy(true);
    try {
      const r = await rpc<Record<string, unknown> & { status: string }>(fn, args);
      setResult(['LOADED', 'STARTED', 'UNDONE', 'BOOKING_OPEN', 'OK', 'CLOSED'].includes(r.status) ? ok(r) : { tone: 'bad', title: r.status.replaceAll('_', ' ').toLowerCase() });
      await load();
    } catch (e) {
      // Not retried by itself (pressing twice would act twice): show what the server has now instead.
      setResult(e instanceof NetworkError
        ? { tone: 'warn', title: 'Connection dropped', detail: 'It may or may not have gone through. The stopwatch above shows where the batch is now; press again only if it hasn’t changed.' }
        : { tone: 'bad', title: 'Failed', detail: (e as Error).message });
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!board) return <section className="card h-28 animate-pulse" aria-hidden />;
  if (!meal) return null;
  const b = board.batch;
  const booked = board.expected.filter((p) => p.kind !== 'LUCKY');
  const lucky = board.expected.filter((p) => p.kind === 'LUCKY');
  const startsIn = countdown(meal.service_start_at, now);

  return (
    <section className="card grid gap-4">
      {board.meals.length > 1 && (
        <nav className="no-scrollbar -mt-1 flex gap-2 overflow-x-auto text-sm" aria-label="Events today">
          {board.meals.map((m) => (
            <button key={m.id} onClick={() => setMealId(m.id)} aria-current={meal.id === m.id ? 'page' : undefined}
              className={`shrink-0 rounded-full border px-3 py-1 ${meal.id === m.id ? 'border-fg bg-fg text-bg' : 'border-border'}`}>
              {mealLabel(m)} · {timeRange(m.service_start_at)}
            </button>
          ))}
        </nav>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-xl font-bold leading-tight">{mealLabel(meal)}</h2>
        </div>
        <div className="shrink-0 pt-0.5 text-right">
          <p className="flex items-center justify-end gap-1.5 text-sm text-muted"><Clock size={14} aria-hidden /> {timeRange(meal.service_start_at)}</p>
          {startsIn && <p className="mt-1 text-xs font-medium text-fg">in {startsIn}</p>}
        </div>
      </div>

      {!near ? (
        <p className="rounded-2xl bg-subtle px-4 py-3 text-sm text-muted">
          The gate controls appear here at <b className="text-fg">{timeRange(new Date(new Date(meal.service_start_at).getTime() - CONTROL_LEAD_MS).toISOString())}</b>, an hour before the start.
          Batch 1 booking opens by itself {b ? `at ${timeRange(b.booking_opens_at)}` : '15 minutes before'}.
        </p>
      ) : (
        <>
          <BatchClock b={b} previous={board.previous} now={now} />
          {b && <SeatBar b={b} />}

          <dl className="grid grid-cols-4 divide-x divide-border/70 rounded-2xl border border-border/70 py-2.5">
            <Stat label="Booked" value={b ? String(b.taken) : '—'} of={b ? b.capacity : undefined} />
            <Stat label="Lucky?" value={b?.lucky_capacity ? String(b.lucky_taken ?? 0) : '—'} of={b?.lucky_capacity || undefined} />
            <Stat label="In" value={String(b?.arrived ?? 0)} />
            <Stat label="To come" value={String(board.expected.length)} />
          </dl>

          {b?.phase === 'NOT_OPEN' && <p className="text-sm text-muted">Booking for batch {b.number} opens at {timeRange(b.booking_opens_at)}.</p>}
          {b?.phase === 'BOOKING' && b.starts_at && (
            <p className="text-sm text-muted">Booking is open. The gate opens at {timeRange(b.starts_at)}{countdown(b.starts_at, now) ? ` (in ${countdown(b.starts_at, now)})` : ''}.</p>
          )}
          {b?.phase === 'ARRIVING' && (
            <ConfirmButton variant="primary" disabled={busy}
              onConfirm={() => act('load_batch', { p_meal_service_id: meal.id }, () => ({
                tone: 'ok', title: `Batch ${b.number} filled`,
              }))}>
              <span className="flex items-center justify-center gap-2"><Lock size={18} /> Filled</span>
            </ConfirmButton>
          )}
          {!b && board.previous && meal.state === 'IN_SERVICE' && (
            <OpenBooking key={board.previous.number} next={board.previous.number + 1} initial={board.next_capacity} busy={busy}
              onOpen={(n) => act('open_next_booking', { p_meal_service_id: meal.id, p_capacity: n }, () => ({
                tone: 'ok', title: `Batch ${board.previous!.number + 1} is taking bookings`,
              }))} />
          )}
          {b?.phase === 'BOOKING' && !b.starts_at && (
            <ConfirmButton variant="primary" disabled={busy}
              onConfirm={() => act('start_next_batch', { p_meal_service_id: meal.id }, () => ({
                tone: 'ok', title: `Batch ${b.number}: gate open`,
              }))}>
              <span className="flex items-center justify-center gap-2"><DoorOpen size={18} /> Gate open</span>
            </ConfirmButton>
          )}
          {result && (
            <div className={`rounded-2xl border p-3 ${TONE[result.tone]}`} role="status">
              <p className="flex items-center gap-2 font-semibold">
                {result.tone === 'ok' ? <CircleCheck size={18} /> : result.tone === 'bad' ? <CircleX size={18} /> : <TriangleAlert size={18} />}
                {result.title}
              </p>
              {result.detail && <p className="mt-1 text-sm">{result.detail}</p>}
            </div>
          )}

          {board.expected.length > 0 && (
            <div className="rounded-2xl border border-border">
              <button onClick={() => setLists(!lists)} aria-expanded={lists}
                className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium">
                Who is still to come ({booked.length} booked{lucky.length ? `, ${lucky.length} Lucky?` : ''})
                <ChevronDown size={16} className={`transition ${lists ? 'rotate-180' : ''}`} />
              </button>
              {lists && (
                <div className="grid gap-3 border-t border-border px-3 py-3 text-sm">
                  <p className="text-muted">Order at the gate: <b className="text-fg">1.</b> booked · <b className="text-fg">2.</b> Lucky? · <b className="text-fg">3.</b> no booking</p>
                  <List title="1. Booked, not in yet" people={booked} />
                  {lucky.length > 0 && <List title="2. Lucky?, waiting outside" people={lucky} warn />}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </section>
  );
}

function List({ title, people, warn }: { title: string; people: Person[]; warn?: boolean }) {
  return (
    <div>
      <p className={`mb-1 font-semibold ${warn ? 'text-warn' : 'text-muted'}`}>{title} ({people.length})</p>
      <ul className="grid gap-0.5">
        {people.map((p) => (
          <li key={p.seat_id}><b className="tabular-nums">{p.coupon_number}</b> {titleCase(p.name)}{p.kind === 'JOIN_NOW' && <span className="text-muted"> · join now</span>}</li>
        ))}
      </ul>
    </div>
  );
}

/** One number in the stats row: big value (with "/ capacity" small when given), label under it. */
function Stat({ label, value, of }: { label: string; value: string; of?: number }) {
  return (
    <div className="min-w-0 px-1 text-center">
      <dd className="font-display text-xl font-bold leading-none tabular-nums">
        {value}{of !== undefined && <span className="text-xs font-medium text-muted">/{of}</span>}
      </dd>
      <dt className="mt-1 truncate text-[0.6875rem] text-muted">{label}</dt>
    </div>
  );
}

/** After "Filled": how many may book the next batch (last time's number unless changed), then open booking. */
function OpenBooking({ next, initial, busy, onOpen }: { next: number; initial: number; busy: boolean; onOpen: (n: number) => void }) {
  const [n, setN] = useState(String(initial));
  const valid = /^\d+$/.test(n) && Number(n) >= 1 && Number(n) <= 500;
  return (
    <form className="grid gap-3" onSubmit={(e) => e.preventDefault()}>
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted">How many for batch {next}?</span>
        <input value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric"
          aria-label={`How many students may book batch ${next}`}
          className="font-display h-11 w-20 rounded-xl border border-border bg-subtle text-center text-xl font-bold tabular-nums outline-none focus:border-accent" />
      </label>
      <ConfirmButton variant="primary" disabled={busy || !valid}
        onConfirm={() => { if (valid) onOpen(Number(n)); }}>
        <span className="flex items-center justify-center gap-2"><Ticket size={18} /> Start taking bookings</span>
      </ConfirmButton>
    </form>
  );
}
