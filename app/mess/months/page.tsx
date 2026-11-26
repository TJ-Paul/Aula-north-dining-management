'use client';

import { ArrowLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/admin-shell';
import { monthProgress, type Dashboard } from '@/components/mess-month';
import { PageSkeleton, SkeletonList } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { dateSpan, monthStage } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

/** Every mess month as a simple card; each opens its full details. */
export default function MonthsPage() {
  const session = useSession();
  const { data } = useLoad(session ? () => rpc<Dashboard>('mess_dashboard', { p_mess_month_id: null }) : null, undefined, { cache: 'mess-current' });
  if (!session) return <PageSkeleton />;
  return (
    <AppFrame session={session} active="mess">
      <Link href="/mess" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Mess</Link>
      <h1 className="text-2xl font-semibold tracking-tight">Mess months</h1>
      {!data ? <SkeletonList count={4} /> : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {data.months.map((m) => {
            const stage = monthStage(m);
            const { day, total } = monthProgress(m);
            return (
              <li key={m.id}>
                <Link href={`/mess/month/?month=${m.id}`} className="card flex items-center gap-4 transition hover:bg-subtle active:scale-[0.99]">
                  <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-xl bg-accent-soft text-accent">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {m.banner_url && <img src={m.banner_url} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />}
                    <span className={`absolute right-1 top-1 flex size-6 items-center justify-center rounded-full text-xs font-bold tabular-nums ring-1 ${m.banner_url ? 'bg-black/50 text-white ring-white/60' : 'bg-surface/70 ring-accent/40'}`}>
                      {m.serial}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold">{m.name}</span>
                      {stage === 'Current' ? <Badge tone="ok">Current</Badge> : stage === 'Upcoming' ? <Badge>Upcoming</Badge> : null}
                    </span>
                    <span className="block text-sm text-muted">{dateSpan(m.starts_on, m.ends_on)}</span>
                    <span className="block text-xs text-muted">{stage === 'Ended' ? `${total} days` : stage === 'Current' ? (total - day <= 0 ? 'Last day' : `${total - day} ${total - day === 1 ? 'day' : 'days'} left`) : `${total} days, not started`}</span>
                  </span>
                  <ChevronRight size={18} className="shrink-0 text-muted" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </AppFrame>
  );
}
