'use client';

import { Check, Minus, UserRound } from 'lucide-react';
import Link from 'next/link';
import { mealName, titleCase } from '@/lib/format';

/** A profile photo, or the plain person outline when there is none. */
export function Avatar({ url, size = 'md' }: { url: string | null | undefined; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const box = { sm: 'size-8', md: 'size-10', lg: 'size-16', xl: 'size-24' }[size];
  const icon = { sm: 15, md: 18, lg: 28, xl: 40 }[size];
  return url
    ? <img src={url} alt="" className={`${box} shrink-0 rounded-full object-cover`} />
    : <span className={`${box} flex shrink-0 items-center justify-center rounded-full bg-subtle text-muted`}><UserRound size={icon} aria-hidden /></span>;
}

export type PersonCard = {
  user_id: string; name: string | null; avatar_url: string | null; room: string | null; student_id: string | null; coupon_number: number | null;
};

/** Photo, name, coupon and student ID on one line; a link when `href` is given. */
export function PersonLine({ p, href, right }: { p: PersonCard; href?: string; right?: React.ReactNode }) {
  const body = (
    <>
      <Avatar url={p.avatar_url} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{titleCase(p.name) ?? '—'}</span>
        <span className="block truncate text-xs text-muted">
          Coupon {p.coupon_number ?? '—'}{p.student_id && ` · ${p.student_id}`}{p.room && ` · room ${p.room}`}
        </span>
      </span>
    </>
  );
  return (
    <div className="flex items-center gap-3 py-2">
      {href ? <Link href={href} className="flex min-w-0 flex-1 items-center gap-3 hover:underline">{body}</Link> : body}
      {right}
    </div>
  );
}

export type MealDay = {
  date: string;
  meals: Array<{ id: string; meal_type: string; name: string | null; occasion: string; special: boolean; ate: boolean; over: boolean }>;
};

/** Day by day: each meal ticked (ate) or crossed, with a View link to that day. */
export function MealDaysTable({ days, viewHref }: { days: MealDay[]; viewHref?: (date: string) => string }) {
  if (days.length === 0) return <p className="text-sm text-muted">No meals yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {days.map((d) => (
        <li key={d.date} className="flex items-center gap-3 py-2.5">
          <span className="w-16 shrink-0 text-sm">
            {new Date(`${d.date}T12:00:00+06:00`).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' })}
            <span className="block text-xs text-muted">{new Date(`${d.date}T12:00:00+06:00`).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'short' })}</span>
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {d.meals.map((m) => (
              <span key={m.id} className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${
                m.ate ? 'bg-ok-soft text-ok' : m.over ? 'bg-subtle text-muted' : 'border border-border text-muted'}`}>
                {m.ate ? <Check size={13} /> : <Minus size={13} />}
                {m.special && m.name ? m.name : mealName(m.meal_type)}
              </span>
            ))}
          </span>
          {viewHref && <Link href={viewHref(d.date)} className="shrink-0 text-sm font-medium text-accent">View</Link>}
        </li>
      ))}
    </ul>
  );
}
