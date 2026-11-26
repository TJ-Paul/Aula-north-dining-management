'use client';

import { ArrowLeft, CircleCheck, CircleX, Search, TriangleAlert, Undo2, UserRound, Utensils, X } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GateControl } from '@/components/gate-control';
import { type Batch } from '@/components/meal-booking';
import { mealLabel } from '@/components/meal-card';
import { PageSkeleton } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { elapsed, timeRange, titleCase } from '@/lib/format';
import { NetworkError, rpc, rpcRetry } from '@/lib/rpc';
import { isAdmin, isStaff, useSession } from '@/lib/session';
import { pollWhileVisible } from '@/lib/poll';
import { withBase } from '@/lib/base';

type MealRef = { id: string; name: string | null; meal_type: string; occasion: string; service_start_at: string; state: string };
type Person = { seat_id: string | null; attendance_id?: string; coupon_number: number; name: string | null; kind: string };
type Board = {
  meals: MealRef[]; meal: MealRef | null; batch: Batch | null; turnover_minutes: number; not_coming: number;
  expected: Array<Person & { deadline: string | null; lapsed: boolean }>;
  arrivals: Array<Person & { arrived_at: string }>;
  history: Array<{ number: number; starts_at: string | null; loaded_at: string; arrived: number; missed: number }>;
  previous: { number: number; starts_at: string | null; loaded_at: string; arrived: number; missed: number; capacity: number } | null;
  next_capacity: number;
};
type DirEntry = {
  coupon_number: number; name: string | null; student_id: string | null; room: string | null; avatar_url: string | null;
  has_account: boolean; ate: boolean; said_not_coming: boolean;
  seat: { state: string; kind: string; batch: number; deadline: string | null; lapsed: boolean } | null;
};
type Tone = 'ok' | 'warn' | 'bad' | 'info';
type Result = { tone: Tone; title: string; detail?: string };

function resultFor(coupon: number, r: { status: string; name?: string | null; said_not_coming?: boolean }): Result {
  const who = r.name ?? 'No account yet: ask them to claim this coupon in the app after eating (their meal will be kept)';
  const nc = '';
  switch (r.status) {
    case 'ARRIVED': return { tone: 'ok', title: `${coupon} in`, detail: who + (nc ? `.${nc}` : '') };
    case 'ARRIVED_LUCKY': return { tone: 'warn', title: `${coupon} in (Lucky?)`, detail: `${who}. Lucky?: let them in after the booked students.${nc}` };
    case 'ARRIVED_LATE': return { tone: 'ok', title: `${coupon} in (late)`, detail: `${who}. Their time had run out; let them in.${nc}` };
    case 'WALK_IN': return { tone: 'ok', title: `${coupon} in (no booking)`, detail: `${who}. No booking, but let them in.${nc}` };
    case 'EARLY': return { tone: 'ok', title: `${coupon} ate`, detail: `${who}. Taken before the start: no seat used, and they can’t book now.` };
    case 'ALREADY_ARRIVED': return { tone: 'info', title: `${coupon} is already in`, detail: 'Not counted again.' };
    case 'UNKNOWN_COUPON': return { tone: 'bad', title: `${coupon} is not an issued coupon`, detail: 'Check the number with the student.' };
    case 'BATCH_FULL': return { tone: 'bad', title: 'Batch is full', detail: `${coupon} can’t come in now. They can book the next batch.` };
    case 'BATCH_NOT_STARTED': return { tone: 'bad', title: 'Too early for coupons', detail: 'Coupons are taken from an hour before the start until the meal is closed.' };
    case 'MEAL_CLOSED': return { tone: 'bad', title: 'This meal is closed', detail: 'No more coupons are taken for it.' };
    case 'NO_OPEN_BATCH': return { tone: 'bad', title: 'No batch is open for this meal' };
    default: return { tone: 'info', title: r.status };
  }
}

/** What Undo needs: the seat, or for a coupon taken before the start (no seat) its "ate" record. */
const undoKey = (seatId: string | null, attendanceId?: string) =>
  seatId ? `seat:${seatId}` : attendanceId ? `early:${attendanceId}` : null;

/** Check-in results that let someone in (and can be undone). */
const IN = ['ARRIVED', 'ARRIVED_LUCKY', 'ARRIVED_LATE', 'WALK_IN', 'EARLY'];

const TONE: Record<Tone, string> = {
  ok: 'border-ok bg-ok-soft', warn: 'border-warn bg-warn-soft', bad: 'border-bad bg-bad-soft', info: 'border-border bg-subtle',
};

/** The door: take each coupon as students walk in, then load the batch and start the next one. */
export function Door() {
  const session = useSession();
  const [mealId, setMealId] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dir, setDir] = useState<DirEntry[] | null>(null);
  const [last, setLast] = useState<{ d: DirEntry | null; coupon: number; seatId: string | null; result: Result; status: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setBoard(await rpc<Board>('door_board', { p_meal_service_id: mealId }));
      setError(null);
    } catch (e) {
      setError(e instanceof NetworkError ? 'No connection. Check the Wi-Fi; nothing was recorded.' : (e as Error).message);
    }
  }, [mealId]);

  useEffect(() => {
    if (!session || !isStaff(session)) return;
    load();
    const stop = pollWhileVisible(load, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { stop(); clearInterval(tick); };
  }, [session, load]);

  useEffect(() => {
    if (session && !isStaff(session)) location.href = withBase('/');
  }, [session]);

  const meal = board?.meal ?? null;
  const b = board?.batch ?? null;
  const mealKey = meal?.id ?? null;

  // Everyone in the register with their status for this meal, for the suggestions and the profile card.
  const loadDir = useCallback(async () => {
    if (!mealKey) return;
    try { setDir(await rpc<DirEntry[]>('door_directory', { p_meal_service_id: mealKey })); } catch { /* keep the last list */ }
  }, [mealKey]);
  useEffect(() => {
    loadDir();
    return pollWhileVisible(loadDir, 30000);   // also reloaded after every check-in
  }, [loadDir]);

  const matches = digits && dir
    ? dir.filter((d) => String(d.coupon_number).startsWith(digits))
      .sort((x, y) => (x.coupon_number === Number(digits) ? -1 : y.coupon_number === Number(digits) ? 1 : x.coupon_number - y.coupon_number))
      .slice(0, 6)
    : [];
  const collected = dir ? dir.filter((d) => d.ate).length : null;

  // Type the number and press Enter (or tap a suggestion): they're let in at once, with an Undo.
  const letIn = async (coupon: number) => {
    if (!meal || busy) return;
    const d = dir?.find((x) => x.coupon_number === coupon) ?? null;
    setBusy(true);
    try {
      // A dropped connection is retried by itself (a coupon taken twice is refused, never counted twice).
      const raw = await rpcRetry<{ status: string; name?: string | null; said_not_coming?: boolean; seat?: { id: string; kind: string }; attendance_id?: string }>(
        'door_check_in', { p_meal_service_id: meal.id, p_coupon_number: coupon },
        () => setLast({ d, coupon, seatId: null, status: 'RETRYING',
          result: { tone: 'info', title: `${coupon}: weak connection, still trying…`, detail: 'Keep the student here a moment.' } }));
      // "Already in" on a retry means the first try did get through: show it as let in.
      const got = raw.retried && raw.status === 'ALREADY_ARRIVED' ? { ...raw, status: 'ARRIVED' } : raw;
      // A Lucky? place is let in like a booking, but shown apart: they go in after the booked students.
      const r = got.status === 'ARRIVED' && got.seat?.kind === 'LUCKY' ? { ...got, status: 'ARRIVED_LUCKY' } : got;
      setLast({ d, coupon, seatId: IN.includes(r.status) ? undoKey(r.seat?.id ?? null, r.attendance_id) : null,
        result: resultFor(coupon, r), status: r.status });
      setDigits('');
      inputRef.current?.focus();
      await Promise.all([load(), loadDir()]);
    } catch (e) {
      setLast({ d, coupon, seatId: null, status: 'ERROR',
        result: { tone: 'bad', title: 'Not recorded', detail: e instanceof NetworkError ? 'No connection. Let them in and type the number again when the Wi-Fi is back.' : (e as Error).message } });
    } finally {
      setBusy(false);
    }
  };

  /** `key` is a seat (`seat:<id>`) or, for a coupon taken before the start, its record (`early:<id>`). */
  const undo = async (key: string, coupon: number) => {
    setBusy(true);
    try {
      const [what, id] = key.split(':');
      if (what === 'early') await rpcRetry('undo_early_check_in', { p_attendance_id: id });
      else await rpcRetry('undo_check_in', { p_seat_id: id });
      setLast({ d: null, coupon, seatId: null, status: 'UNDONE', result: { tone: 'info', title: `${coupon} undone`, detail: 'Not counted.' } });
      await Promise.all([load(), loadDir()]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  if (!session || !board) {
    return error ? <main className="flex min-h-dvh items-center justify-center px-6 text-center text-muted">{error}</main> : <PageSkeleton />;
  }

  return (
    <AppFrame session={session} active={isAdmin(session) ? 'admin' : 'attendant'}>
      {isAdmin(session) && <Link href="/admin" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Dashboard</Link>}

      {board.meals.length > 1 && (
        <nav className="no-scrollbar flex gap-2 overflow-x-auto text-sm" aria-label="Meals today">
          {board.meals.map((m) => (
            <button key={m.id} onClick={() => setMealId(m.id)} aria-current={meal?.id === m.id ? 'page' : undefined}
              className={`shrink-0 rounded-full border px-3 py-1 ${meal?.id === m.id ? 'border-fg bg-fg text-bg' : 'border-border'}`}>
              {mealLabel(m)} · {timeRange(m.service_start_at)}
            </button>
          ))}
        </nav>
      )}

      {!meal ? (
        <section className="card flex flex-col items-center gap-2 py-10 text-center text-muted">
          <Utensils size={28} aria-hidden />
          <p className="font-medium text-fg">No improvement, feast or paron today</p>
          <p className="text-sm">Coupons are collected at special meals. Lunch and dinner are ticked under Attendance.</p>
        </section>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <h1 className="truncate text-lg font-semibold">{mealLabel(meal)} · {timeRange(meal.service_start_at)}</h1>

          {/* How many have dined: the one number the door needs. */}
          <div className="relative grid grid-cols-[1fr_auto] items-center gap-3 overflow-hidden rounded-3xl bg-gradient-to-br from-accent to-accent/80 px-5 py-4 text-accent-fg shadow-lg shadow-accent/20">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider opacity-90">Dined</p>
              <p className="text-6xl font-bold leading-none tabular-nums">{collected ?? '…'}</p>
              <p className="mt-1 text-xs opacity-90">coupons collected</p>
            </div>
            <div className="text-right text-sm">
              {b ? <p><b className="tabular-nums">{b.arrived}</b><span className="opacity-80">/{b.capacity} in batch {b.number}</span></p>
                : board.previous && <p className="opacity-80">Batch {board.previous.number} filled</p>}
              {b?.phase === 'ARRIVING' && b.starts_at && <p className="text-xs opacity-80">gate open {elapsed(b.starts_at, now)}</p>}
              {!b && board.previous && <p className="text-xs opacity-80">{elapsed(board.previous.loaded_at, now)} ago</p>}
            </div>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); if (digits) letIn(Number(digits)); }} className="relative">
            <label className="sr-only" htmlFor="coupon">Coupon number</label>
            <div className="flex items-center gap-2 rounded-2xl border-2 border-border bg-surface px-4 focus-within:border-accent">
              <Search size={22} className="shrink-0 text-muted" aria-hidden />
              <input id="coupon" ref={inputRef} autoFocus autoComplete="off" inputMode="numeric" enterKeyHint="done" size={4}
                className="h-16 min-w-0 flex-1 bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:text-lg placeholder:font-normal placeholder:text-muted"
                value={digits} onChange={(e) => setDigits(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="Coupon → let in" />
              {digits && (
                <button type="button" onClick={() => { setDigits(''); inputRef.current?.focus(); }}
                  aria-label="Clear" className="rounded-full p-1 text-muted hover:bg-subtle"><X size={22} /></button>
              )}
            </div>
            {matches.length > 0 && (
              <ul className="absolute inset-x-0 top-full z-20 mt-2 grid max-h-[18rem] gap-0.5 overflow-y-auto rounded-2xl border border-border bg-surface p-1 shadow-xl"
                aria-label="Matching coupons: tap to let in">
                {matches.map((d, i) => (
                  <li key={d.coupon_number}>
                    <button type="button" onClick={() => letIn(d.coupon_number)} disabled={busy || d.ate}
                      className={`flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-subtle disabled:opacity-60 ${i === 0 ? 'bg-subtle' : ''}`}>
                      <Avatar url={d.avatar_url} size="sm" />
                      <b className="w-10 tabular-nums">{d.coupon_number}</b>
                      <span className="min-w-0 flex-1 truncate">{titleCase(d.name) ?? 'Not in the register'}</span>
                      <StatusBadge d={d} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </form>

          {last && <LastCard last={last} busy={busy} onUndo={undo} />}
          {error && <p className="text-sm text-bad">{error}</p>}

          <section>
            <h2 className="mb-1 text-sm font-semibold text-muted">Just came in</h2>
            {board.arrivals.length === 0 ? <p className="text-sm text-muted">Nobody yet.</p> : (
              <ul className="divide-y divide-border text-sm">
                {board.arrivals.map((p) => (
                  <li key={p.seat_id ?? p.attendance_id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate"><b className="tabular-nums">{p.coupon_number}</b> {titleCase(p.name) ?? 'no account yet'}
                      {p.kind === 'WALK_IN' && <span className="text-muted"> · no booking</span>}
                      {p.kind === 'EARLY' && <span className="text-muted"> · before the start</span>}
                      {p.kind === 'LUCKY' && <span className="text-warn"> · Lucky?</span>}</span>
                    <button className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-muted hover:bg-subtle" disabled={busy}
                      onClick={() => undo(undoKey(p.seat_id, p.attendance_id)!, p.coupon_number)}>
                      <Undo2 size={14} /> Undo
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {/* Door staff have no dashboard: their gate controls sit under the coupons. */}
      {!isAdmin(session) && <GateControl />}
    </AppFrame>
  );
}

function Avatar({ url, size = 'md' }: { url: string | null; size?: 'sm' | 'lg' | 'md' }) {
  const box = size === 'sm' ? 'size-8' : size === 'lg' ? 'size-16' : 'size-10';
  return url
    ? <img src={url} alt="" className={`${box} shrink-0 rounded-full object-cover`} />
    : <span className={`${box} flex shrink-0 items-center justify-center rounded-full bg-subtle text-muted`}>
        <UserRound size={size === 'lg' ? 30 : 16} aria-hidden /></span>;
}

function status(d: DirEntry): { text: string; tone: 'ok' | 'warn' | 'bad' | 'info' } {
  if (d.ate) return { text: 'Already in', tone: 'info' };
  if (d.seat && d.seat.state === 'HOLDING' && !d.seat.lapsed && d.seat.kind === 'LUCKY') return { text: `Lucky? · batch ${d.seat.batch}`, tone: 'warn' };
  if (d.seat && d.seat.state === 'HOLDING' && !d.seat.lapsed) return { text: `Booked · batch ${d.seat.batch}`, tone: 'ok' };
  if (d.seat && (d.seat.lapsed || d.seat.state === 'RELEASED')) return { text: 'Time ran out', tone: 'warn' };
  if (!d.has_account) return { text: 'No account yet', tone: 'warn' };
  return { text: 'No booking', tone: 'info' };
}

function StatusBadge({ d }: { d: DirEntry }) {
  const st = status(d);
  const c = { ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', info: 'bg-subtle text-muted' }[st.tone];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{st.text}</span>;
}

/** The person just let in, big and clear, with an Undo for a mistyped number. */
function LastCard({ last, busy, onUndo }: {
  last: { d: DirEntry | null; coupon: number; seatId: string | null; result: Result; status: string };
  busy: boolean; onUndo: (seatId: string, coupon: number) => void;
}) {
  const { d, result } = last;
  const tag = last.status === 'WALK_IN' ? (d && !d.has_account ? 'No account yet' : 'No booking')
    : last.status === 'ARRIVED' ? 'Booked' : last.status === 'ARRIVED_LUCKY' ? 'Lucky?' : last.status === 'ARRIVED_LATE' ? 'Booked (late)' : null;
  return (
    <div className={`rounded-3xl border-2 p-4 ${TONE[result.tone]}`} role="status">
      <div className="flex items-center gap-4">
        {d ? <BigAvatar url={d.avatar_url} /> : null}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            {result.tone === 'ok' ? <CircleCheck size={18} /> : result.tone === 'bad' ? <CircleX size={18} /> : <TriangleAlert size={18} />}
            {result.title}
          </p>
          {d && <p className="mt-1 truncate text-2xl font-bold leading-tight">{titleCase(d.name) ?? 'No account yet'}</p>}
          {d && <p className="text-base">Coupon <b className="tabular-nums">{d.coupon_number}</b>{d.student_id && <> · {d.student_id}</>}{d.room && <> · room {d.room}</>}</p>}
          {tag && <span className="mt-1 inline-block rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium">{tag}</span>}
        </div>
      </div>
      {(!d || !IN.includes(last.status) || last.status === 'ARRIVED_LUCKY') && result.detail && <p className="mt-2 text-sm">{result.detail}</p>}
      {d && !d.has_account && last.seatId && <p className="mt-2 text-sm">Ask them to claim coupon {d.coupon_number} in the app after eating; this meal is kept.</p>}
      {last.seatId && (
        <button disabled={busy} onClick={() => onUndo(last.seatId!, last.coupon)}
          className="mt-3 flex items-center gap-1.5 rounded-xl bg-surface px-3 py-2 text-sm font-medium text-muted hover:text-fg">
          <Undo2 size={16} /> Undo (wrong number)
        </button>
      )}
    </div>
  );
}

function BigAvatar({ url }: { url: string | null }) {
  return url
    ? <img src={url} alt="" className="size-24 shrink-0 rounded-2xl object-cover" />
    : <span className="flex size-24 shrink-0 items-center justify-center rounded-2xl bg-surface text-muted"><UserRound size={44} aria-hidden /></span>;
}

