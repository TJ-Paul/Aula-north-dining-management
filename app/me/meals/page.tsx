'use client';

import { ArrowLeft, CalendarCheck, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { MealDaysTable, type MealDay } from '@/components/person';
import { PageSkeleton, SkeletonList } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type Extras = { walk_ins: number };

/** My Meals: every day with a meal, ticked where the student ate; 30 days at a time. */
export default function MyMealsPage() {
  const session = useSession();
  const [days, setDays] = useState(30);
  const { data } = useLoad(session ? () => rpc<MealDay[]>('my_meal_days', { p_days: days }) : null, undefined, { cache: `my-meal-days-${days}` });
  const extras = useLoad(session ? () => rpc<Extras>('my_extras') : null, undefined, { cache: 'my-extras' });
  if (!session) return <PageSkeleton />;
  const ate = data?.reduce((n, d) => n + d.meals.filter((m) => m.ate).length, 0) ?? 0;

  return (
    <AppFrame session={session} active="profile">
      <Link href="/me/profile" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Profile</Link>
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><CalendarCheck size={22} className="text-accent" /> My Meals</h1>
      {data && (
        <p className="text-sm text-muted">You ate <b className="text-fg tabular-nums">{ate}</b> {ate === 1 ? 'meal' : 'meals'} in the last {days} days.</p>
      )}
      {!!extras.data?.walk_ins && (
        <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>Joined without booking <b>{extras.data.walk_ins}</b> {extras.data.walk_ins === 1 ? 'time' : 'times'}. Please book a seat next time; it takes a few seconds.</span>
        </p>
      )}
      <section className="card">
        {!data ? <SkeletonList count={3} /> : <MealDaysTable days={data} viewHref={(d) => `/me/day/?date=${d}`} />}
      </section>
      {data && days < 365 && (
        <button onClick={() => setDays(days === 30 ? 90 : 365)} className="mx-auto rounded-full border border-border px-4 py-2 text-sm font-medium">
          Show {days === 30 ? 'the last 90 days' : 'the whole year'}
        </button>
      )}
    </AppFrame>
  );
}
