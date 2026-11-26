'use client';

import { ArrowLeft, CalendarDays, Ticket } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AdminShell, Empty } from '@/components/admin-shell';
import { MealDaysTable, type MealDay } from '@/components/person';
import { dhakaDate, titleCase } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Coupon = {
  coupon_number: number; register: { name?: string; student_id?: string } | null; holder: string | null; pending_claim: boolean;
  meals_eaten: number; last_meal_at: string | null; days: MealDay[];
};

/** The page's id is in the address (?n=…), so one static page serves them all. */
export default function Page() {
  return <Suspense><CouponPage /></Suspense>;
}

function CouponPage() {
  const q = useSearchParams();
  const n = q.get('n') ?? '';
  return <AdminShell active="everyone" plain>{() => <CouponView key={n} n={Number(n)} />}</AdminShell>;
}

/** A coupon nobody has claimed yet: who the register says it is, and every meal eaten on it. */
function CouponView({ n }: { n: number }) {
  const { data, error } = useLoad(() => rpc<Coupon>('admin_coupon', { p_coupon_number: n }));
  if (!data) return <Empty>{error ?? 'Loading…'}</Empty>;
  if (data.holder) {
    return <p>Coupon {n} has an account. <Link className="text-accent underline" href={`/admin/person/?id=${data.holder}`}>Open their page</Link>.</p>;
  }
  return (
    <>
      <Link href="/admin/everyone" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Database</Link>
      <section className="card flex flex-wrap items-center gap-4">
        <span className="flex size-20 items-center justify-center rounded-2xl bg-subtle text-muted"><Ticket size={34} /></span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{titleCase(data.register?.name ?? null) ?? `Coupon ${n}`}</h1>
          <p className="text-muted">Coupon <b className="text-fg tabular-nums">{n}</b> · {data.register?.student_id ?? 'no student ID'}</p>
          <p className="mt-1 text-sm text-warn">{data.pending_claim ? 'Claim waiting for an admin.' : 'No account yet.'} Meals below move to the student once their claim is approved.</p>
        </div>
      </section>
      <div className="grid grid-cols-2 gap-3">
        <div className="card py-3"><p className="text-2xl font-semibold tabular-nums">{data.meals_eaten}</p><p className="text-xs text-muted">Dined</p></div>
        <div className="card py-3"><p className="text-lg font-semibold">{data.last_meal_at ? dhakaDate(data.last_meal_at) : '—'}</p><p className="text-xs text-muted">Last meal</p></div>
      </div>
      <section className="card">
        <h2 className="mb-1 flex items-center gap-2 font-semibold"><CalendarDays size={18} className="text-accent" /> Meals on this coupon</h2>
        <MealDaysTable days={data.days} />
      </section>
    </>
  );
}
