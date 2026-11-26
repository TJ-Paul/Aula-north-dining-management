'use client';

import { ArrowLeft, Check, Megaphone, Minus } from 'lucide-react';
import { PageSkeleton } from '@/components/skeleton';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AppFrame } from '@/components/top-bar';
import { OCCASION, mealTitle, timeRange } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type DayMeal = {
  id: string; name: string | null; meal_type: string; occasion: string; special: boolean; state: string;
  service_start_at: string; service_end_at: string | null; notice: string | null; description: string | null; ate: boolean;
  items: Array<{ name: string; alternatives: string[]; my_choice: string | null }>;
};

/** One day's meals: what was served, when, notices, the student's picks, and whether they ate. */
/** The page's id is in the address (?date=…), so one static page serves them all. */
export default function Page() {
  return <Suspense><DayPage /></Suspense>;
}

function DayPage() {
  const q = useSearchParams();
  const date = q.get('date') ?? '';
  const session = useSession();
  const { data } = useLoad(session ? () => rpc<DayMeal[]>('meal_day', { p_date: date }) : null, undefined, { cache: `day-${date}` });
  if (!session || !data) return <PageSkeleton />;
  const title = new Date(`${date}T12:00:00+06:00`).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <AppFrame session={session} active="profile">
      <Link href="/me/meals" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> My Meals</Link>
      <h1 className="text-2xl font-semibold">{title}</h1>
      {data.length === 0 && <p className="text-muted">No meals that day.</p>}
      {data.map((m) => (
        <section key={m.id} className="card grid gap-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">{mealTitle(m)}</h2>
              <p className="text-sm text-muted">
                {timeRange(m.service_start_at, m.service_end_at)}{m.occasion !== 'REGULAR' && ` · ${OCCASION[m.occasion]}`}
              </p>
            </div>
            <span className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${m.ate ? 'bg-ok-soft text-ok' : 'bg-subtle text-muted'}`}>
              {m.ate ? <><Check size={13} /> Ate</> : <><Minus size={13} /> Didn’t eat</>}
            </span>
          </div>
          {m.notice && <p className="flex gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn"><Megaphone size={16} className="mt-0.5 shrink-0" />{m.notice}</p>}
          {m.description && <p className="whitespace-pre-line text-sm">{m.description}</p>}
          {m.items.length > 0 && (
            <ul className="divide-y divide-border text-sm">
              {m.items.map((it) => (
                <li key={it.name} className="flex justify-between gap-3 py-1.5">
                  <span>{it.my_choice ?? it.name}</span>
                  {it.alternatives.length > 0 && (
                    <span className="text-xs text-muted">{it.my_choice ? `you chose this instead of ${it.name}` : `or ${it.alternatives.join(' / ')}`}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </AppFrame>
  );
}
