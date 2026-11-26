'use client';

import { CircleCheck, Clock, TriangleAlert, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Sheet } from '@/components/sheet';
import { OCCASION, countdown, elapsed, mealTitle, signedCountdown, timeRange } from '@/lib/format';
import { NetworkError, mealLive, rpc, rpcRetry } from '@/lib/rpc';
import { keep, readKept } from '@/lib/use-load';
import { pollWhileVisible } from '@/lib/poll';

export type Batch = {
  id: string; number: number; phase: 'NOT_OPEN' | 'BOOKING' | 'ARRIVING' | 'LOADED'; capacity: number; taken: number;
  arrived: number; booking_opens_at: string; starts_at: string | null; loaded_at: string | null;
  arrival_minutes: number; join_minutes: number;
  /** Lucky? places: 10% extra once every seat is taken (amendments 1.4, 1.6). */
  lucky_capacity?: number; lucky_taken?: number;
};
export type Seat = {
  id: string; batch_number: number; seq: number; kind: 'BOOKED' | 'JOIN_NOW' | 'WALK_IN' | 'LUCKY';
  state: 'HOLDING' | 'ARRIVED' | 'RELEASED' | 'CANCELLED' | 'MISSED'; coupon_number: number; booked_at: string;
  arrived_at: string | null; deadline: string | null; lapsed: boolean; token: string;
};
export type Seating = {
  meal_state: string; batch: Batch | null; mine: Seat | null; ate: boolean; said_not_coming: boolean;
  previous: { number: number; starts_at: string | null; loaded_at: string; arrived: number; missed: number; capacity: number } | null;
  estimate_next_start: string | null;
  as_of?: string;
};
/** The part that is the same for every student (from /api/meal-live). */
type Shared = Pick<Seating, 'meal_state' | 'batch' | 'previous' | 'estimate_next_start' | 'as_of'>;

/** What changes a seat holder's own seat: the batch opening its gate, filling, the meal closing. */
const sharedKey = (v: Seating) =>
  [v.meal_state, v.batch?.id, v.batch?.starts_at, v.previous?.number].join('|');

/** How often to re-check this student's own seat when nothing else asks for it. */
function mineEvery(v: Seating) {
  if (v.mine?.state === 'HOLDING' && v.batch?.phase === 'ARRIVING') return 10000; // waiting to be checked in at the door
  if (v.mine?.state === 'HOLDING') return 30000;
  return 60000;
}

const MESSAGES: Record<string, string> = {
  NOT_VERIFIED: 'Your coupon must be approved before you can book.',
  BOOKING_NOT_OPEN: 'Booking hasn’t opened yet.',
  SAID_NOT_COMING: 'You said you’re not coming. Undo that first.',
  FULL: 'Booking is closed for this batch. The next batch opens after this one is filled.',
  ALREADY_ATE: 'Your coupon is already recorded for this meal.',
  MEAL_CLOSED: 'This meal is over.',
  BOOKING_PAUSED: 'The batch just filled. Booking for the next batch opens soon.',
  TOO_LATE: 'Too late to cancel: your time ran out.',
};

/** A stopwatch counting up from `since`, for the three batch moments everyone sees. */
export function Stopwatch({ label, since, now, tone = 'accent' }: { label: string; since: string; now: number; tone?: 'accent' | 'warn' | 'ok' }) {
  const color = TONE_STYLE[tone];
  return (
    <div className={`flex items-center justify-between gap-3 rounded-2xl px-3.5 py-2.5 ${color}`} role="timer" aria-label={`${label}, ${elapsed(since, now)}`}>
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span className="live-dot [--dot:currentColor]" aria-hidden />
        {label}
      </span>
      <span className="font-display text-xl font-bold tabular-nums">{elapsed(since, now)}</span>
    </div>
  );
}

/** The live "x / 60 seats" bar everyone sees. */
export function SeatBar({ b }: { b: Batch }) {
  const pct = Math.min(100, Math.round((b.taken / b.capacity) * 100));
  const full = b.taken >= b.capacity;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="text-muted">Batch {b.number}</span>
        <span className="tabular-nums"><b>{b.taken}</b><span className="text-muted">/{b.capacity} seats
          {!!b.lucky_capacity && (full || !!b.lucky_taken) && <> · <span className="text-warn">Lucky? {b.lucky_taken ?? 0}/{b.lucky_capacity}</span></>}
          {b.phase === 'ARRIVING' && ` · ${b.arrived} in`}</span></span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-subtle" role="progressbar" aria-valuemin={0} aria-valuemax={b.capacity}
        aria-valuenow={b.taken} aria-label={`Batch ${b.number}: ${b.taken} of ${b.capacity} seats taken`}>
        <div className={`h-full rounded-full transition-all ${full ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

type MealRef = { id: string; name?: string | null; meal_type: string; occasion?: string | null; service_start_at: string };

/**
 * One meal's booking card: title and time (when given the meal), the live seat
 * bar, and the one thing to do now (book, join, the arrival countdown...).
 */
export function MealBooking({ mealId, meal, bare, initial }: {
  mealId?: string; meal?: MealRef; bare?: boolean; initial?: Seating;
}) {
  const id = meal?.id ?? mealId!;
  // `initial` comes with the home screen's one call (my_home), so the card needn't ask again at once.
  const [s, setS] = useState<Seating | null>(initial ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [conn, setConn] = useState<string | null>(null);
  const [clockOpen, setClockOpen] = useState(false);
  const [askCancel, setAskCancel] = useState(false);

  // Two kinds of refresh (after the 2026-11-07 freeze, when every open screen asked the
  // database for everything every 3 seconds):
  // - the shared state (open batch, seats taken, last filled) every ~3 s from /api/meal-live,
  //   which is cached, so hundreds of phones cost the database almost nothing;
  // - this student's own seat (meal_seating) only when it can have changed: after their own
  //   action, when the batch they hold a seat in moves on, and now and then (see mineEvery).
  const sRef = useRef<Seating | null>(null);
  sRef.current = s;
  const mineAt = useRef(initial ? Date.now() : 0);
  const shownKey = useRef(initial ? sharedKey(initial) : '');
  const hadInitial = useRef(!!initial);

  const loadMine = useCallback(async () => {
    try {
      const v = await rpc<Seating>('meal_seating', { p_meal_service_id: id });
      mineAt.current = Date.now();
      shownKey.current = sharedKey(v);
      setS(v);
      setConn(null);
      // Keep the latest seat on the phone (inside the saved home screen): it shows at once next time,
      // and the coupon and token still show at the gate with no signal.
      const home = readKept<{ seating?: Record<string, Seating> }>('home');
      if (home) keep('home', { ...home, seating: { ...home.seating, [id]: v } });
    } catch (e) {
      setConn(e instanceof NetworkError ? e.message || 'No connection.' : (e as Error).message);
    }
  }, [id]);

  const tick = useCallback(async () => {
    const cur = sRef.current;
    if (!cur) return loadMine();
    let shared: Shared | null;
    try {
      shared = await mealLive<Shared | null>(id);
      setConn(null);
    } catch (e) {
      setConn(e instanceof NetworkError ? e.message || 'No connection.' : (e as Error).message);
      return;
    }
    if (!shared) return;
    // A cached answer can be a moment older than what this phone already shows.
    if (cur.as_of && shared.as_of && Date.parse(shared.as_of) < Date.parse(cur.as_of)) return;
    const next = { ...cur, ...shared };
    setS(next);
    const key = sharedKey(next);
    const moved = key !== shownKey.current;
    shownKey.current = key;
    if (moved && cur.mine?.state === 'HOLDING') {
      // Their batch opened its gate, filled or closed: their seat changed. Spread the phones out.
      await new Promise((r) => setTimeout(r, Math.random() * 3000));
      return loadMine();
    }
    if (Date.now() - mineAt.current > mineEvery(next)) return loadMine();
  }, [id, loadMine]);

  // Every 3 s only while seats are being grabbed (or booking opens within a minute) and this student has
  // none yet; otherwise every 10 s (the gate opening and seat changes also arrive as push notifications).
  const opensSoon = s?.batch?.phase === 'NOT_OPEN' && new Date(s.batch.booking_opens_at).getTime() - now < 60000;
  const racing = !!s?.batch && (s.batch.phase === 'BOOKING' || opensSoon) && s.mine?.state !== 'HOLDING' && !s.ate;
  useEffect(() => {
    if (!hadInitial.current) loadMine();
    hadInitial.current = false;
  }, [loadMine]);
  useEffect(() => {
    const stop = pollWhileVisible(tick, racing ? 3000 : 10000);
    return stop;
  }, [tick, racing]);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  const act = async (fn: string) => {
    setBusy(true);
    setMsg(null);
    try {
      // Booking and cancelling are safe to send twice, so a dropped connection is retried by itself.
      const r = await rpcRetry<{ status: string; opens_at?: string }>(fn, { p_meal_service_id: id },
        () => setMsg('Weak connection. Still trying…'));
      setMsg(null);
      if (MESSAGES[r.status]) setMsg(MESSAGES[r.status]);
      setConfirmCancel(false);
      await loadMine();
    } catch (e) {
      setMsg(e instanceof NetworkError ? 'No connection right now. Your tap may not have reached the server; check again in a moment.' : (e as Error).message);
      // A timed-out press may still have gone through: show what the server has now.
      if (e instanceof NetworkError) loadMine();
    } finally {
      setBusy(false);
    }
  };

  if (!s) return bare ? <div className="h-16 animate-pulse rounded-xl bg-subtle" /> : <section className="card h-40 animate-pulse" />;
  const b = s.batch;
  const seat = s.mine && (s.mine.state === 'ARRIVED' || (b && s.mine.batch_number === b.number)) ? s.mine : null;
  const free = b ? b.capacity - b.taken : 0;
  const luckyFree = b ? (b.lucky_capacity ?? 0) - (b.lucky_taken ?? 0) : 0;
  const live = s.meal_state !== 'CLOSED' && s.meal_state !== 'CANCELLED';
  // Booked: the batch timer shrinks into the "Seat booked" strip (tap it for the full line); otherwise the full bar.
  const clock = live ? clockInfo(b, s.previous) : null;
  const corner = !!seat && seat.state === 'HOLDING' && !seat.lapsed && seat.kind !== 'LUCKY' && !!clock;

  let tone: 'ok' | 'warn' | 'accent' | 'plain' = 'plain';
  let body: React.ReactNode;
  if (s.ate || seat?.state === 'ARRIVED') {
    tone = 'ok';
    body = <Big icon={<CircleCheck size={22} className="text-ok" />} title="You’re in. Enjoy!" />;
  } else if (s.meal_state === 'CLOSED' || s.meal_state === 'CANCELLED' || (!b && !s.previous)) {
    body = <p className="text-muted">{s.meal_state === 'CANCELLED' ? 'Cancelled.' : 'This meal is over.'}</p>;
  } else if (!b) {
    // The last batch is filled; the staff open booking for the next one when they are ready.
    body = <p className="flex items-center gap-2"><Clock size={18} className="text-muted" aria-hidden /> Booking for batch {s.previous!.number + 1} opens soon. Keep this open.</p>;
  } else if (seat && seat.state === 'HOLDING' && !seat.lapsed && seat.kind === 'LUCKY') {
    tone = 'warn';
    body = (
      <>
        <div className="text-center">
          <p className="text-2xl font-semibold text-warn">Lucky?</p>
          <p className="text-sm text-muted">{b.phase === 'ARRIVING' ? 'Gate open: come and wait outside the gate.' : `Bonus place in batch ${b.number}`}</p>
        </div>
        <LuckyExplainer />
        <Quiet armed={confirmCancel} disabled={busy} onClick={() => (confirmCancel ? act('cancel_seat') : setConfirmCancel(true))}>
          {confirmCancel ? 'Sure?' : 'I can’t come'}
        </Quiet>
      </>
    );
  } else if (seat && seat.state === 'HOLDING' && !seat.lapsed) {
    // No personal timer (amendment 1.7): when the gate opens, booked students simply come.
    const started = b.phase === 'ARRIVING';
    tone = started ? 'accent' : 'ok';
    body = (
      <>
        {/* One green strip: live dot, "Seat booked" with what to do now, and the cancel button at the right. */}
        <div className="flex items-stretch overflow-hidden rounded-2xl border border-ok/30">
          <div className="min-w-0 flex-1 bg-ok-soft px-3.5 py-2.5">
            <p className="truncate font-semibold leading-tight text-ok">Seat booked</p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className={`text-[0.8125rem] leading-snug ${started ? 'font-semibold text-fg' : 'text-fg/70'}`}>
                {started ? 'Come now' : b.starts_at ? `Be there at ${timeRange(b.starts_at)}` : 'Come when the gate opens'}
              </p>
              {corner && clock && (
                <button type="button" onClick={() => setClockOpen(true)} aria-label={`${clock.label}, ${elapsed(clock.since, now)}. Show details`}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 ${TONE_STYLE[clock.tone]} ring-1 ring-inset ring-current/20`}>
                  <span className="live-dot [--dot:currentColor]" aria-hidden />
                  <span className="font-display text-xs font-bold tabular-nums">{elapsed(clock.since, now)}</span>
                </button>
              )}
            </div>
          </div>
          {/* The short red end of the strip: give up the seat (asks first). */}
          <button type="button" onClick={() => setAskCancel(true)} disabled={busy}
            aria-label={started ? 'I can’t come' : 'Cancel booking'}
            className="flex w-12 shrink-0 items-center justify-center bg-bad text-accent-fg hover:brightness-110 disabled:opacity-40">
            <X size={20} strokeWidth={2.4} aria-hidden />
          </button>
        </div>
        {askCancel && (
          <Sheet title={started ? 'Can’t come?' : 'Cancel booking?'} onClose={() => setAskCancel(false)}>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setAskCancel(false)}>Keep my seat</Button>
              <Button variant="danger" disabled={busy} onClick={() => { setAskCancel(false); act('cancel_seat'); }}>
                {started ? 'Can’t come' : 'Yes, cancel'}
              </Button>
            </div>
          </Sheet>
        )}
      </>
    );
  } else {
    if (s.said_not_coming) {
      body = <p className="text-muted">You said you’re not coming.</p>;
    } else if (b.phase === 'NOT_OPEN') {
      body = (
        <div className="flex items-center gap-3">
          <Clock size={20} className="text-muted" aria-hidden />
          <p>Booking opens <b>{timeRange(b.booking_opens_at)}</b>
            {countdown(b.booking_opens_at, now) && <span className="text-muted"> · in {countdown(b.booking_opens_at, now)}</span>}</p>
        </div>
      );
    } else if (free <= 0 && luckyFree > 0) {
      // Every seat is taken: a few more can still come as Lucky? (they wait outside, go in after the booked).
      tone = 'warn';
      body = (
        <div className="grid gap-2">
          <p className="text-sm">All {b.capacity} seats are booked. You can still take a <b>Lucky?</b> place: you come too, but go in after the booked students.</p>
          <Button variant="primary" disabled={busy} className="book-btn w-full text-lg" onClick={() => act('book_seat')}>
            Take a Lucky? place · {luckyFree} left
          </Button>
        </div>
      );
    } else if (free <= 0) {
      tone = 'warn';
      body = <p className="flex items-center gap-2"><Users size={18} aria-hidden /> Booking is closed for batch {b.number}. Booking for batch {b.number + 1} opens after this one is filled.</p>;
    } else {
      tone = 'accent';
      const join = b.phase === 'ARRIVING';
      body = (
        <Button variant="primary" disabled={busy} className="book-btn w-full text-lg" onClick={() => act('book_seat')}>
          {join ? `Join now · ${free} left` : `Book a seat · ${free} left`}
        </Button>
      );
    }
  }

  const inner = (
    <>
      {live && !corner && <BatchClock b={b} previous={s.previous} now={now} />}
      {corner && clockOpen && (
        <Sheet title="Batch status" onClose={() => setClockOpen(false)}>
          <div className="grid gap-3">
            <BatchClock b={b} previous={s.previous} now={now} />
            {b && <SeatBar b={b} />}
          </div>
        </Sheet>
      )}
      {/* The seat count matters to those still looking for a seat; once booked or in, it is noise. */}
      {b && live && !s.ate && !(seat && seat.state !== 'RELEASED' && seat.state !== 'CANCELLED' && !seat.lapsed) && <SeatBar b={b} />}
      <div>{body}</div>
      {msg && <p className="text-sm text-muted" role="status">{msg}</p>}
      {conn && !msg && <p className="text-sm text-muted" role="status">{conn}</p>}
    </>
  );
  if (bare) return <div className="grid grid-cols-[minmax(0,1fr)] gap-3">{inner}</div>;
  const ring = { ok: 'ring-2 ring-ok/40', warn: 'ring-2 ring-warn/40', accent: 'ring-2 ring-accent/50', plain: '' }[tone];
  return (
    <section className={`card grid gap-4 ${ring}`}>
      {meal && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{mealTitle(meal)}</h2>
            <p className="text-sm text-muted">{timeRange(meal.service_start_at)}</p>
          </div>
          {meal.occasion && meal.occasion !== 'REGULAR' && <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">{OCCASION[meal.occasion]}</span>}
        </div>
      )}
      {inner}
    </section>
  );
}

/**
 * The stopwatch for where the meal is now: "Batch 2 filled", "Batch 3 taking bookings"
 * or "Batch 3 gate open", each counting up from the moment the staff pressed it.
 */
export function BatchClock({ b, previous, now }: { b: Batch | null; previous: Seating['previous']; now: number }) {
  const c = clockInfo(b, previous);
  return c && <Stopwatch label={c.label} since={c.since} now={now} tone={c.tone} />;
}

type Clock = { label: string; since: string; tone: 'accent' | 'warn' | 'ok' };
const TONE_STYLE: Record<Clock['tone'], string> = { accent: 'bg-accent-soft text-accent', warn: 'bg-warn-soft text-warn', ok: 'bg-ok-soft text-ok' };

/** What the batch stopwatch shows now (or nothing between moments). */
function clockInfo(b: Batch | null, previous: Seating['previous']): Clock | null {
  if (!b && previous) return { label: `Batch ${previous.number} filled`, since: previous.loaded_at, tone: 'warn' };
  if (b?.phase === 'ARRIVING' && b.starts_at) return { label: `Batch ${b.number} gate open`, since: b.starts_at, tone: 'ok' };
  if (b?.phase === 'BOOKING' && !b.starts_at) return { label: `Batch ${b.number} taking bookings`, since: b.booking_opens_at, tone: 'accent' };
  return null;
}

/** What a Lucky? place means, on the student's own screen. */
function LuckyExplainer() {
  return (
    <div className="rounded-xl bg-warn-soft/60 px-3 py-2.5 text-sm">
      <p className="font-medium">You got a bonus place. You can come too.</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
        <li>Wait outside the gate when it opens.</li>
        <li>Booked students go in first, then Lucky? students, then anyone without a booking.</li>
        <li>If a booked student cancels before the gate opens, you move up to a confirmed seat (you’ll get a notice).</li>
        <li>Can’t come? Tap “I can’t come” so someone else can have it.</li>
      </ul>
    </div>
  );
}

function Big({ icon, title }: { icon: React.ReactNode; title: string }) {
  return <p className="flex items-center gap-2 text-lg font-semibold">{icon}{title}</p>;
}

/** A small, quiet cancel button; the second tap (armed) turns it red. */
function Quiet({ armed, disabled, onClick, children, className = 'mx-auto mt-1 block text-sm' }: {
  armed: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode; className?: string;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick}
      className={`lift-soft min-h-9 rounded-full border px-5 font-medium disabled:opacity-40 ${className} ${armed ? 'border-bad bg-bad text-accent-fg' : 'border-border bg-surface text-fg/80 hover:text-fg'}`}>
      {children}
    </button>
  );
}

export function Card({ children, tone }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'accent' }) {
  const border = tone === 'ok' ? 'border-ok' : tone === 'warn' ? 'border-warn' : tone === 'accent' ? 'border-fg' : 'border-border';
  return <section className={`rounded-2xl border-2 bg-surface p-5 ${border}`}>{children}</section>;
}
