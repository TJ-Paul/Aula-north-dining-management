'use client';

import { CakeSlice, ChevronRight, Clock, Megaphone, PartyPopper, Sparkles, Utensils, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { Coming } from '@/components/coming';
import { MealBooking, type Seating } from '@/components/meal-booking';
import { MenuChips, parseMenu } from '@/components/menu-chips';
import { mealName, timeRange } from '@/lib/format';
import type { ReactNode } from 'react';

export type MealBrief = {
  id: string; name: string | null; meal_type: string; occasion: string; special: boolean; state: string;
  service_start_at: string; service_end_at: string | null; menu?: string[]; notice?: string | null; poster_url?: string | null;
  choices_close_at?: string | null;
};

export type Kind = 'REGULAR' | 'IMPROVEMENT' | 'FEAST' | 'PARON';

/** Improvement, feast and paron each have their own colour; lunch and dinner the app's own. */
export function mealKind(m: { meal_type: string; occasion?: string | null }): Kind {
  if (m.meal_type === 'PARON') return 'PARON';
  if (m.occasion === 'IMPROVEMENT' || m.occasion === 'FEAST') return m.occasion;
  return 'REGULAR';
}

export const KIND: Record<Kind, { label: string; icon: LucideIcon; tile: string; badge: string; stripe: string; ring: string }> = {
  REGULAR: { label: '', icon: Utensils, tile: 'bg-accent-soft text-accent', badge: 'bg-subtle text-muted', stripe: 'bg-accent/50', ring: '' },
  IMPROVEMENT: { label: 'Improvement', icon: Sparkles, tile: 'bg-gold-soft text-gold', badge: 'bg-gold-soft text-gold', stripe: 'bg-gold', ring: 'ring-1 ring-gold/40' },
  FEAST: { label: 'Feast', icon: PartyPopper, tile: 'feast-fill shadow-md shadow-[#2563eb]/30', badge: 'feast-fill shadow-sm', stripe: 'feast-fill', ring: 'feast-card' },
  PARON: { label: 'Paron', icon: CakeSlice, tile: 'bg-bad-soft text-bad', badge: 'bg-bad-soft text-bad', stripe: 'bg-bad', ring: 'ring-1 ring-bad/30' },
};

/** The main dish's chip, in the meal's colour. */
const HERO: Record<Kind, string> = {
  REGULAR: 'bg-accent text-accent-fg', IMPROVEMENT: 'bg-gold text-surface', FEAST: 'feast-fill', PARON: 'bg-accent text-accent-fg',
};

/** The meal's own name, or its kind: "Biriyani night", "Improvement", "Dinner". */
export function mealLabel(m: { name?: string | null; meal_type: string; occasion?: string | null }) {
  const k = mealKind(m);
  return m.name || (k === 'REGULAR' ? mealName(m.meal_type) : KIND[k].label);
}

const dhaka = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', ...o });

/** A calendar tile: "13", "NOV '26", tinted by the meal's kind. */
export function DateTile({ iso, kind, faded, size = 'md', tall, flush }: {
  iso: string; kind: Kind; faded?: boolean; size?: 'md' | 'lg'; tall?: boolean;
  /** Fill the card's left side edge to edge (no rounded box of its own). */ flush?: boolean;
}) {
  const lg = size === 'lg';
  return (
    <span className={`flex shrink-0 flex-col items-center justify-center ${tall ? 'self-stretch' : ''} ${flush ? '-my-4 w-[clamp(4.25rem,21vw,5.25rem)] py-2.5' : lg ? 'w-[clamp(3.6rem,19vw,4.5rem)] rounded-[1.25rem] py-2.5' : 'w-14 rounded-2xl py-2'} ${faded ? 'bg-subtle text-muted' : KIND[kind].tile}`}>
      <span className={`${lg ? 'text-xs' : 'text-[0.6875rem]'} font-medium uppercase leading-none opacity-80`}>{dhaka(iso, { weekday: 'short' })}</span>
      <span className={`font-display mt-0.5 ${lg ? 'text-[clamp(1.35rem,7vw,1.75rem)]' : 'text-xl'} font-extrabold leading-tight tabular-nums`}>{dhaka(iso, { day: 'numeric' })}</span>
      <span className={`${lg ? 'text-[0.6875rem]' : 'text-[0.625rem]'} font-semibold uppercase leading-none tracking-wide`}>
        {dhaka(iso, { month: 'short' })} <span className="font-normal opacity-70">’{dhaka(iso, { year: '2-digit' })}</span>
      </span>
    </span>
  );
}

/** "8:30 – 10:30 pm" (am/pm once when both ends share it), "11:30 am – 1:30 pm" otherwise. */
function shortRange(start: string, end: string | null) {
  if (!end) return timeRange(start);
  const a = timeRange(start), b = timeRange(end);
  const sa = a.slice(-2), sb = b.slice(-2);
  return sa === sb ? `${a.slice(0, -3)} – ${b}` : `${a} – ${b}`;
}

/** The kind as a small coloured label (not shown for a plain lunch or dinner). */
export function KindBadge({ kind, faded }: { kind: Kind; faded?: boolean }) {
  if (kind === 'REGULAR') return null;
  const K = KIND[kind];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${faded ? 'bg-subtle text-muted' : K.badge}`}>
      <K.icon size={12} aria-hidden /> {K.label}
    </span>
  );
}

/**
 * One meal, the same card everywhere (Meals tab, Mess lists, Dashboard → All meals): date tile, name,
 * kind, time at the top right, the dishes under the name, any notice. On the Meals tab today's special
 * meal carries its booking and an upcoming paron its "I'm coming". Past meals are faded but keep their
 * colour, so an improvement or feast is still easy to spot; a cancelled one turns grey.
 * `ate` is a small count tile at the bottom right; `aside` sits with the name's badges (e.g. "Serving", how many ate), so the dishes stay right under the name; `children` at the bottom (e.g. a manager's actions),
 * and `onSelect` makes the card's top tappable. `plain`: just the meal (no booking, "I'm coming" or
 * "Choose your dish"), for lists, so they never ask the server anything extra.
 */
export function MealCard({ meal, seating, when, aside, ate, hideKind, children, onSelect, selected, plain, highlight, preview }: {
  meal: MealBrief; seating?: Seating; when: 'today' | 'upcoming' | 'past'; ate?: number; hideKind?: boolean;
  /** Today's meal on the student's home: a warm edge so it is seen first. */ highlight?: boolean;
  aside?: ReactNode; children?: ReactNode; onSelect?: () => void; selected?: boolean; plain?: boolean;
  /** Managers looking at the students' screen: everything shows, but nothing can be tapped to book or join. */
  preview?: boolean;
}) {
  const kind = mealKind(meal);
  const past = when === 'past';
  const cancelled = meal.state === 'CANCELLED';
  // Past: faded, colour kept. Cancelled: grey.
  const grey = cancelled;
  const faded = past || cancelled;
  const started = new Date(meal.service_start_at).getTime() <= Date.now();
  const menu = meal.menu ?? [];
  const canChoose = !plain && !preview && !faded && !started && menu.some((x) => / \(or /.test(x))
    && (!meal.choices_close_at || new Date(meal.choices_close_at).getTime() > Date.now());
  // The live booking card (which refreshes every few seconds) only from an hour before the start;
  // until then a quiet line says when booking opens.
  const near = Date.now() > new Date(meal.service_start_at).getTime() - 60 * 60000;
  const live = !plain && when === 'today' && !!seating && !cancelled && meal.state !== 'CLOSED';
  const badges = (
    <>
      {meal.name && kind === 'REGULAR' ? <span className="rounded-full bg-subtle px-2 py-0.5 text-[0.6875rem] font-medium text-muted">{mealName(meal.meal_type)}</span>
        : !hideKind && <KindBadge kind={kind} faded={grey} />}
      {cancelled && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[0.6875rem] font-semibold text-bad">Cancelled</span>}
      {aside}
    </>
  );
  const chips = menu.length > 0 && <MenuChips items={parseMenu(menu)} star={kind !== 'REGULAR' && !grey} size={past ? 'sm' : 'md'} hero={HERO[kind]} />;
  const time = past ? null : (
    <p className="flex shrink-0 items-center gap-1 whitespace-nowrap text-[0.8125rem] text-muted">
      <Clock size={13} aria-hidden /> {shortRange(meal.service_start_at, meal.service_end_at)}
    </p>
  );
  // With a count tile (the list pages) the tile sits at the right, the time goes under the name and the dishes
  // run the full width, so no corner is left empty. Otherwise: time at the top right, dishes under the name.
  const top = ate !== undefined ? (
    <div className="grid gap-3 text-left">
      <div className="flex items-center gap-[clamp(0.5rem,3vw,0.75rem)]">
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className={`text-[clamp(0.9rem,5vw,1.125rem)] font-bold leading-snug tracking-tight ${cancelled ? 'line-through' : ''}`}>{mealLabel(meal)}</h3>
            {kind === 'REGULAR' && <CountChip n={ate} />}
            {badges}
          </div>
          {time}
        </div>
        {kind !== 'REGULAR' && <span className="flex size-[clamp(2.75rem,15vw,3.5rem)] shrink-0 items-center justify-center rounded-2xl bg-subtle text-[clamp(1.1rem,6.5vw,1.5rem)] font-bold tabular-nums" aria-label={`${ate} ate`}>{ate}</span>}
      </div>
      {chips}
    </div>
  ) : (
    <div className="flex items-start text-left">
      <div className="grid min-w-0 flex-1 gap-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className={`text-[clamp(0.9rem,5vw,1.125rem)] font-bold leading-snug tracking-tight ${cancelled ? 'line-through' : ''}`}>{mealLabel(meal)}</h3>
            {badges}
          </div>
          {time && <div className="pt-1">{time}</div>}
        </div>
        {chips}
      </div>
    </div>
  );

  return (
    <article className={`card relative flex items-stretch gap-[clamp(0.75rem,3.5vw,1rem)] overflow-hidden !pl-0 transition ${grey ? 'opacity-60 saturate-50' : `${KIND[kind].ring} ${highlight && kind === 'REGULAR' ? 'today-card' : ''} ${past && !selected ? 'opacity-70' : ''}`} ${selected ? 'ring-2 ring-accent' : ''}`}>
      {/* The date fills the card's whole left side, edge to edge; everything else sits beside it. */}
      <DateTile iso={meal.service_start_at} kind={kind} faded={grey} size="lg" tall flush />
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] content-start gap-3">
      {meal.poster_url && !cancelled && (
        <img src={meal.poster_url} alt={`${mealLabel(meal)} poster`} loading="lazy" className="-mt-1 max-h-80 w-full rounded-xl bg-subtle object-contain" />
      )}
      {/* Name with the time at the top right, and the dishes right under the name. */}
      {onSelect ? <button type="button" onClick={onSelect} aria-expanded={selected} className="w-full">{top}</button> : top}

      {meal.notice && !past && (
        <p className="flex gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn"><Megaphone size={16} className="mt-0.5 shrink-0" />{meal.notice}</p>
      )}
      {canChoose && (
        <Link href={`/events/view/?id=${meal.id}`} className="flex w-fit items-center gap-1 text-sm font-medium text-accent">
          Choose your dish <ChevronRight size={15} />
        </Link>
      )}

      {live && meal.special && (near ? (
        <div className="border-t border-border pt-3">
          <MealBooking mealId={meal.id} initial={seating} bare />
        </div>
      )
        : seating?.batch && (
          <p className="flex items-center gap-2 border-t border-border pt-3 text-sm text-muted">
            <Clock size={15} aria-hidden /> Booking opens at <b className="text-fg">{timeRange(seating.batch.booking_opens_at)}</b>. You’ll get a notification.
          </p>
        ))}
      {kind === 'PARON' && !plain && !faded && !started && <Coming mealId={meal.id} open={!preview && meal.state === 'SCHEDULED'} />}
      {children}
      </div>
    </article>
  );
}

/** A small count beside a lunch's or dinner's name (improvements and feasts get the big tile instead). */
function CountChip({ n }: { n: number }) {
  return <span className="rounded-lg bg-subtle px-2 py-0.5 text-sm font-bold tabular-nums text-fg" aria-label={`${n} ate`}>{n}</span>;
}

/** The Dhaka calendar day of a time, as a key for grouping. */
export const dayKey = (iso: string) => dhaka(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * A day's meals in one card: the date once down the left (in the special meal's colour when the day has
 * one), then each meal one under the other: poster (special meals), name, time, dishes and, for past
 * ones, how many ate.
 */
export function DayCard<T extends MealBrief>({ meals, when, ate, selectedId, onSelect, aside, extra }: {
  meals: T[]; when: 'upcoming' | 'past'; ate?: (m: T) => number | undefined;
  /** Managers: tap a meal in the card to open its own buttons (`extra`, under that meal); badges in `aside`. */
  selectedId?: string | null; onSelect?: (m: T) => void; aside?: (m: T) => ReactNode; extra?: (m: T) => ReactNode;
}) {
  const past = when === 'past';
  // Later meal first: dinner (or the evening's special) above lunch.
  const sorted = [...meals].sort((a, b) => new Date(b.service_start_at).getTime() - new Date(a.service_start_at).getTime());
  const dayKind = sorted.map((m) => mealKind(m)).find((k) => k !== 'REGULAR') ?? 'REGULAR';
  return (
    <article className={`card relative flex items-stretch gap-[clamp(0.75rem,3.5vw,1rem)] overflow-hidden !pl-0 ${KIND[dayKind].ring} ${past ? 'opacity-70' : ''}`}>
      {/* The date fills the card's whole left side, edge to edge. */}
      <DateTile iso={sorted[0].service_start_at} kind={dayKind} size="lg" tall flush />
      <div className="grid min-w-0 flex-1 gap-3 divide-y divide-border [&>*+*]:pt-3">
        {sorted.map((m) => {
          const n = ate?.(m);
          const menu = m.menu ?? [];
          const k = mealKind(m);
          const special = k !== 'REGULAR';
          return (
            <section key={m.id} id={`meal-${m.id}`} className="grid scroll-mt-20 gap-2">
              {(() => {
                const head = (
                  <div className="grid gap-2 text-left">
                    {special && m.poster_url && (
                      <img src={m.poster_url} alt={`${mealLabel(m)} poster`} loading="lazy" className="max-h-80 w-full rounded-xl bg-subtle object-contain" />
                    )}
                    <div className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className={`text-[clamp(0.9rem,5vw,1.125rem)] font-bold leading-snug tracking-tight ${selectedId === m.id ? 'text-accent' : ''}`}>{mealLabel(m)}</h3>
                        {n !== undefined && <CountChip n={n} />}
                        {special && m.name && <KindBadge kind={k} />}
                        {aside?.(m)}
                      </div>
                      {!past && (
                        <p className="flex items-center gap-1 whitespace-nowrap text-[0.8125rem] text-muted">
                          <Clock size={13} aria-hidden /> {shortRange(m.service_start_at, m.service_end_at)}
                        </p>
                      )}
                    </div>
                    {menu.length > 0 && <MenuChips items={parseMenu(menu)} star={special} size="sm" hero={HERO[k]} />}
                  </div>
                );
                return onSelect
                  ? <button type="button" onClick={() => onSelect(m)} aria-expanded={selectedId === m.id} className="w-full">{head}</button>
                  : head;
              })()}
              {extra?.(m)}
            </section>
          );
        })}
      </div>
    </article>
  );
}

/**
 * Groups a list (in order) so a day's meals that may share a card sit together: regular ones always, the
 * special ones too with `specials`. Anything else (a cancelled meal, or one that must stay on its own) is a
 * group of one.
 */
type Groupable = { id: string; meal_type: string; occasion?: string | null; service_start_at: string; notice?: string | null; menu?: string[]; state?: string };
export function groupDays<T extends Groupable>(list: T[], canMerge: (m: T) => boolean = () => true,
  /** Also put a day's improvement, feast or paron in the day's card (lists without their own buttons). */ opts: { specials?: boolean } = {}): T[][] {
  const out: T[][] = [];
  const byDay = new Map<string, T[]>();
  for (const m of list) {
    if ((mealKind(m) !== 'REGULAR' && !opts.specials) || m.state === 'CANCELLED' || !canMerge(m)) { out.push([m]); continue; }
    const k = dayKey(m.service_start_at);
    const g = byDay.get(k);
    if (g) g.push(m); else { const n = [m]; byDay.set(k, n); out.push(n); }
  }
  return out;
}

/** Upcoming meals with a notice or a dish to choose keep their own card (the merged card has neither). */
export const mergeable = (m: Groupable) => !m.notice && !(m.menu ?? []).some((x) => / \(or /.test(x));
