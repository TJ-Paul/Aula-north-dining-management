'use client';

import { Megaphone } from 'lucide-react';
import Link from 'next/link';
import { Empty } from '@/components/admin-shell';
import { PageSkeleton, SkeletonList } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { dhakaDate, dhakaTime } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { isAdmin, useSession } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type Announcement = { id: string; body: string; created_at: string; by: string | null };

/** Announcements from the mess managers, newest first (where an announcement notification opens). */
export default function AnnouncementsPage() {
  const session = useSession();
  const { data } = useLoad(session ? () => rpc<Announcement[]>('list_announcements', { p_limit: 30 }) : null, undefined,
    { cache: 'announcements', fresh: 60000 });
  if (!session) return <PageSkeleton />;
  return (
    <AppFrame session={session} active="mess">
      <div className="flex items-center justify-between px-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold"><Megaphone size={18} /> Announcements</h1>
        {isAdmin(session) && <Link href="/admin/announcements" className="text-sm font-medium text-accent">Send one</Link>}
      </div>
      {!data ? <SkeletonList count={3} /> : data.length === 0 ? <Empty>No announcements yet.</Empty> : (
        <ul className="grid gap-2">
          {data.map((a) => (
            <li key={a.id} className="card">
              <p className="whitespace-pre-line">{a.body}</p>
              <p className="mt-1 text-xs text-muted">{dhakaDate(a.created_at)} · {dhakaTime(a.created_at)}</p>
            </li>
          ))}
        </ul>
      )}
    </AppFrame>
  );
}
