'use client';

import { ArrowLeft, Eye } from 'lucide-react';
import Link from 'next/link';
import { AdminShell } from '@/components/admin-shell';
import { type MealBrief } from '@/components/meal-card';
import { SkeletonList } from '@/components/skeleton';
import { StudentMeals } from '@/components/student-meals';
import { mealsLive } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

/**
 * Dashboard → Student view: the students' Meals screen as they see it (today, coming up, earlier folded),
 * for the mess managers and the Dev. Only to look at: booking and "I'm coming" can't be tapped here.
 * One cached call (/api/meals-live, the same one the students' phones use), refreshed every 2 minutes.
 */
export default function StudentViewPage() {
  return <AdminShell active="student-view" plain>{() => <StudentView />}</AdminShell>;
}

function StudentView() {
  const { data, error } = useLoad(() => mealsLive<{ meals: MealBrief[] }>(), 2 * 60000, { cache: 'student-view' });
  return (
    <div className="mx-auto grid w-full max-w-xl grid-cols-[minmax(0,1fr)] content-start gap-4">
      <div className="flex items-center justify-between gap-3">
        <Link href="/admin" className="flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Dashboard</Link>
        <span className="flex items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">
          <Eye size={13} aria-hidden /> Student view
        </span>
      </div>
      {data ? <StudentMeals board={data.meals} preview /> : <SkeletonList />}
      {error && <p className="text-center text-sm text-muted" role="status">{error}</p>}
    </div>
  );
}
