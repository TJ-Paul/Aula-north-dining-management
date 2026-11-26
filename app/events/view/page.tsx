'use client';

import { ArrowLeft, Megaphone, LoaderCircle, Utensils } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Badge } from '@/components/admin-shell';
import { MealBooking } from '@/components/meal-booking';
import { AppFrame } from '@/components/top-bar';
import { OCCASION, dhakaDate, mealName, mealTitle, timeRange } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { isAdmin, useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type Item = {
  id: string; name: string; alternatives: Array<{ id: string; name: string }>; my_choice: string | null;
  totals: Array<{ alternative: string; count: number }> | null;
};
type Detail = {
  id: string; name: string | null; meal_type: string; occasion: string; service_start_at: string; service_end_at: string | null;
  state: string; special: boolean; description: string | null; notice: string | null; poster_url: string | null; items: Item[]; can_choose: boolean; attended: boolean;
  choices_close_at: string | null;
  mess_month: { id: string; serial: number; name: string; over: boolean } | null;
  managers: Array<{ user_id: string; name: string; status: string; my_stars: number | null }>;
  can_rate: boolean; can_send_feedback: boolean; attendance: number | null;
};

/** The page's id is in the address (?id=…), so one static page serves them all. */
export default function Page() {
  return <Suspense><EventPage /></Suspense>;
}

function EventPage() {
  const q = useSearchParams();
  const id = q.get('id') ?? '';
  const session = useSession();
  const { data, reload, error } = useLoad(session ? () => rpc<Detail>('event_detail', { p_meal_service_id: id }) : null);

  if (!session || !data) {
    return <main className="flex min-h-dvh items-center justify-center text-muted">{error ?? <LoaderCircle className="animate-spin" />}</main>;
  }
  const e = data;

  return (
    <AppFrame session={session} active={isAdmin(session) ? 'admin' : 'me'}>
      <Link href={isAdmin(session) ? '/admin' : '/me'} className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> {isAdmin(session) ? 'Dashboard' : 'Meals'}</Link>

      {e.poster_url && (
        <img src={e.poster_url} alt={`${mealTitle(e)} poster`} className="max-h-[28rem] w-full rounded-2xl bg-subtle object-contain" />
      )}
      <section>
        <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">
          {e.occasion !== 'REGULAR' ? OCCASION[e.occasion] : mealName(e.meal_type)}
        </span>
        <h1 className="mt-2 text-3xl font-semibold">{mealTitle(e)}</h1>
        <p className="text-sm text-muted">{dhakaDate(e.service_start_at)} · {timeRange(e.service_start_at, e.service_end_at)}
          {isAdmin(session) && e.attendance !== null && ` · ${e.attendance} ate`}</p>
        {e.notice && <p className="mt-3 flex gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn"><Megaphone size={16} className="mt-0.5 shrink-0" />{e.notice}</p>}
        {e.description && <p className="mt-3 whitespace-pre-line">{e.description}</p>}
      </section>

      {session.coupon_number !== null && (e.state === 'SCHEDULED' || e.state === 'IN_SERVICE') && <MealBooking mealId={e.id} />}
      {e.items.length > 0 && <Menu event={e} admin={isAdmin(session)} onChanged={reload} />}
    </AppFrame>
  );
}

function Menu({ event: e, admin, onChanged }: { event: Detail; admin: boolean; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const closeAt = e.choices_close_at ?? e.service_start_at;
  const canChoose = e.can_choose && Date.now() < new Date(closeAt).getTime();
  const closeText = `${timeRange(closeAt)}, ${dhakaDate(closeAt)}`;
  const choose = async (item: Item, alt: string | null) => {
    try {
      const r = await rpc<{ status: string }>('choose_alternative', { p_item_id: item.id, p_alternative_id: alt });
      setMsg(r.status === 'OK' ? 'Saved ✓' : r.status === 'TOO_LATE' ? `Choices closed at ${closeText}.` : 'Only verified students can choose.');
      onChanged();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  const hasChoices = e.items.some((i) => i.alternatives.length);
  return (
    <section className="card">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold"><Utensils size={18} className="text-accent" /> Menu</h2>
        {hasChoices && <span className="text-xs text-muted">{canChoose ? `Choose by ${timeRange(closeAt)}` : 'Choices closed'}</span>}
      </div>
      <ul className="divide-y divide-border">
        {e.items.map((it) => (
          <li key={it.id} className="py-2.5">
            {it.alternatives.length === 0 ? <span>{it.name}</span> : (
              <div className="inline-flex flex-wrap rounded-full bg-subtle p-1" role="radiogroup" aria-label={`Choice for ${it.name}`}>
                {[{ id: null as string | null, name: it.name }, ...it.alternatives].map((a) => {
                  const selected = (it.my_choice ?? null) === a.id;
                  return (
                    <button key={a.id ?? 'item'} role="radio" aria-checked={selected} disabled={!canChoose} onClick={() => choose(it, a.id)}
                      className={`rounded-full px-4 py-1.5 text-sm transition ${selected ? 'bg-surface font-medium shadow-sm' : 'text-muted'} disabled:cursor-default`}>
                      {a.name}
                    </button>
                  );
                })}
              </div>
            )}
            {admin && it.totals && it.totals.length > 0 && (
              <p className="mt-1 text-xs text-muted">{it.totals.map((t) => `${t.alternative}: ${t.count}`).join(' · ')}</p>
            )}
          </li>
        ))}
      </ul>
      {msg && <p className="mt-1 text-xs text-muted" role="status">{msg}</p>}
    </section>
  );
}
