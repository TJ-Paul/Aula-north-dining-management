'use client';

import { CalendarClock, ChevronDown, ChevronUp, History } from 'lucide-react';
import { useState } from 'react';
import { DayCard, MealCard, groupDays, mergeable, type MealBrief } from '@/components/meal-card';
import { type Seating } from '@/components/meal-booking';
import { dhakaToday } from '@/lib/format';
import { Masonry } from '@/components/masonry';

const dhakaDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(iso));

/**
 * The students' Meals screen: today first and biggest, then the meals planned ahead; earlier ones folded.
 * Managers and the Dev see the same list from Dashboard → Student view (`preview`: no buttons that act).
 */
export function StudentMeals({ board, seating, preview }: {
  board: MealBrief[]; seating?: Record<string, Seating>; preview?: boolean;
}) {
  // Earlier meals stay folded away: today is what matters.
  const [showPast, setShowPast] = useState(false);
  const today = dhakaToday();
  const todays = board.filter((m) => dhakaDay(m.service_start_at) === today);
  const upcoming = board.filter((m) => dhakaDay(m.service_start_at) > today);
  const past = board.filter((m) => dhakaDay(m.service_start_at) < today).reverse();
  const todayLabel = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long' });
  const servingNow = todays.some((m) => m.state !== 'CANCELLED' && m.state !== 'CLOSED'
    && new Date(m.service_start_at).getTime() <= Date.now() && (!m.service_end_at || new Date(m.service_end_at).getTime() > Date.now()));

  return (
    <>
      {/* Today first and biggest: the date, and a live dot while a meal is being served. */}
      <header className="mt-1 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-accent">
            {servingNow && <span className="live-dot" aria-hidden />}{servingNow ? 'Serving now' : 'Today'}
          </p>
          <h1 className="mt-0.5 text-[clamp(1.6rem,8.5vw,2.25rem)] font-extrabold leading-[1.05]">{todayLabel}</h1>
        </div>
      </header>
      {todays.length > 0 ? (
        <Masonry className="grid items-start gap-3">
          {/* A day's lunch and dinner share one card (dinner first); a special meal keeps its own (it has the booking). */}
          {groupDays(todays, mergeable).map((g) => g.length > 1
            ? <DayCard key={g[0].id} meals={g} when="upcoming" />
            : <MealCard key={g[0].id} meal={g[0]} seating={seating?.[g[0].id]} when="today" highlight hideKind preview={preview} />)}
        </Masonry>
      ) : (
        <p className="card text-center text-sm text-muted">No meals today.</p>
      )}

      {upcoming.length > 0 && (
        <>
          <Divider label="Coming up" icon={<CalendarClock size={14} aria-hidden />} />
          <Masonry className="grid items-start gap-3">
            {groupDays(upcoming, mergeable).map((g) => g.length > 1 ? <DayCard key={g[0].id} meals={g} when="upcoming" /> : <MealCard key={g[0].id} meal={g[0]} when="upcoming" hideKind preview={preview} />)}
          </Masonry>
        </>
      )}

      {past.length > 0 && (showPast ? (
        <>
          <div className="mt-3 flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted"><History size={14} aria-hidden />Earlier</span>
            <span className="h-px flex-1 bg-border" aria-hidden />
            <button type="button" onClick={() => setShowPast(false)}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted hover:bg-subtle hover:text-fg">
              Hide <ChevronUp size={14} aria-hidden />
            </button>
          </div>
          <Masonry className="grid items-start gap-3">
            {groupDays(past, undefined, { specials: true }).map((g) => g.length > 1 ? <DayCard key={g[0].id} meals={g} when="past" /> : <MealCard key={g[0].id} meal={g[0]} when="past" hideKind preview={preview} />)}
          </Masonry>
        </>
      ) : (
        <button type="button" onClick={() => setShowPast(true)}
          className="mx-auto mt-1 flex items-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-muted hover:text-fg">
          <History size={15} aria-hidden /> Earlier meals <ChevronDown size={15} aria-hidden />
        </button>
      ))}
    </>
  );
}

/** A labelled line between today, the meals ahead and the past ones. */
function Divider({ label, icon }: { label: string; icon?: React.ReactNode }) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{icon}{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
    </div>
  );
}
