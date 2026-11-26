'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Managers, MonthHero, MonthTiles, type Dashboard } from '@/components/mess-month';
import { PageSkeleton, SkeletonList } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { rpc } from '@/lib/rpc';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

/** One mess month in full: dates, its meals by kind and its managers. */
/** The page's id is in the address (?month=…), so one static page serves them all. */
export default function Page() {
  return <Suspense><MonthPage /></Suspense>;
}

function MonthPage() {
  const q = useSearchParams();
  const month = q.get('month') ?? '';
  const session = useSession();
  const { data, error, reload } = useLoad(session ? () => rpc<Dashboard>('mess_dashboard', { p_mess_month_id: month }) : null, undefined,
    { cache: `mess-${month}` });
  if (!session) return <PageSkeleton />;
  const m = data?.month;
  return (
    <AppFrame session={session} active="mess" width="feed">
      <Link href="/mess/months" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Mess months</Link>
      {!m ? (error ? <p className="text-sm text-bad">{error}</p> : <SkeletonList count={3} />) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <MonthHero month={m} onChanged={reload} />
            <MonthTiles month={m} />
          </div>
          <Managers managers={m.managers} />
        </>
      )}
    </AppFrame>
  );
}
