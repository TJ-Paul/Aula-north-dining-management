'use client';

import { ArrowLeft, CalendarClock, History } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DayCard, MealCard, groupDays, mealKind } from '@/components/meal-card';
import { TILES } from '@/components/mess-month';
import { PageSkeleton, SkeletonList } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type MonthMeal = {
  id: string; name: string | null; meal_type: string; occasion: string; state: string;
  service_start_at: string; service_end_at: string | null; ate: number; menu: string[]; poster_url?: string | null;
};

/** Every meal of one kind in a mess month: planned ones first, then the past ones with how many ate. */
/** The page's id is in the address (?month=…&kind=…), so one static page serves them all. */
export default function Page() {
  return <Suspense><MonthMealsPage /></Suspense>;
}

function MonthMealsPage() {
  const q = useSearchParams();
  const month = q.get('month') ?? '';
  const kind = q.get('kind') ?? '';
  const tile = TILES.find((t) => t.kind === kind) ?? TILES[0];
  const session = useSession();
  const { data, error } = useLoad(session ? () => rpc<MonthMeal[]>('mess_month_meals', { p_mess_month_id: month, p_kind: tile.kind.toUpperCase() }) : null,
    undefined, { cache: `month-meals-${month}-${tile.kind}` });
  if (!session) return <PageSkeleton />;
  const now = Date.now();
  const planned = (data ?? []).filter((m) => new Date(m.service_start_at).getTime() > now).reverse();
  const done = (data ?? []).filter((m) => new Date(m.service_start_at).getTime() <= now);

  return (
    <AppFrame session={session} active="mess">
      <Link href="/mess" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Mess</Link>
      <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
        <span className={`flex size-10 items-center justify-center rounded-2xl ${tile.tone}`}><tile.Icon size={20} aria-hidden /></span>
        {tile.label}
        {data && <span className="text-base font-normal text-muted tabular-nums">{data.length}</span>}
      </h1>
      {!data ? (error ? <p className="text-sm text-bad">{error}</p> : <SkeletonList count={5} />) : data.length === 0 ? (
        <p className="rounded-2xl bg-subtle px-4 py-6 text-center text-sm text-muted">None this month yet.</p>
      ) : (
        <>
          {planned.length > 0 && <Section title="Planned" icon={<CalendarClock size={14} />} list={planned} future tile={tile} />}
          {done.length > 0 && <Section title={planned.length ? 'Done' : ''} icon={<History size={14} />} list={done} tile={tile} />}
        </>
      )}
    </AppFrame>
  );
}

function Section({ title, icon, list, future, tile }: { title: string; icon: React.ReactNode; list: MonthMeal[]; future?: boolean; tile: { kind: string } }) {
  return (
    <section className="grid gap-2">
      {title && (
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">{icon}{title}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      )}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {(tile.kind === 'meals' ? groupDays(list, undefined, { specials: true }) : list.map((m) => [m])).map((g) => g.length > 1 ? (
          <DayCard key={g[0].id} when={future ? 'upcoming' : 'past'} meals={g.map((e) => ({ ...e, special: false }))}
            ate={(m) => (!future ? m.ate : undefined)} />
        ) : g.map((e) => (
          <MealCard key={e.id} plain when={future ? 'upcoming' : 'past'}
            meal={{ ...e, special: mealKind(e) !== 'REGULAR' }}
            hideKind={tile.kind !== 'meals'}
            ate={!future && e.state !== 'CANCELLED' ? e.ate : undefined} />
        )))}
      </div>
    </section>
  );
}

