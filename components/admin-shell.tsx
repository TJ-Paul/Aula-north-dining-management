'use client';

import { withBase } from '@/lib/base';
import {
  ArrowLeft, BadgeCheck, ClipboardCheck, Database, DoorOpen, FileSpreadsheet, Gauge, Smartphone, Megaphone, MessageSquareText, ShieldCheck, Utensils,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/sheet';
import { PageSkeleton } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { isAdmin, isDev, useSession, type Session } from '@/lib/session';

export type AdminTab = 'overview' | 'meals' | 'attendance' | 'announcements' | 'everyone' | 'claims' | 'people' | 'review' | 'registry' | 'student-view';
type Tab = { href: string; key: AdminTab | 'door'; label: string; icon: LucideIcon; hidden?: boolean };

/** The manager pages, in dashboard order. */
const TABS: Tab[] = [
  { href: '/admin', key: 'overview', label: 'Dashboard', icon: Gauge },
  { href: '/attendant', key: 'door', label: 'Collect coupons', icon: DoorOpen },
  { href: '/admin/announcements', key: 'announcements', label: 'Announcement', icon: Megaphone },
  { href: '/admin/meals', key: 'meals', label: 'Meals', icon: Utensils },
  { href: '/admin/attendance', key: 'attendance', label: 'Attendance', icon: ClipboardCheck },
  { href: '/admin/everyone', key: 'everyone', label: 'Database', icon: Database },
  { href: '/admin/review', key: 'review', label: 'Feedback', icon: MessageSquareText },
  { href: '/admin/claims', key: 'claims', label: 'Claims', icon: BadgeCheck },
  { href: '/admin/student-view', key: 'student-view', label: 'Student view', icon: Smartphone },
  { href: '/admin/registry', key: 'registry', label: 'Hall register', icon: FileSpreadsheet },
  { href: '/admin/everyone?section=staff', key: 'people', label: 'Staff & roles', icon: ShieldCheck, hidden: true },
];

/**
 * Manager-only page frame: checks the role; on phones a "← Dashboard" link and the page title
 * (the dashboard is the menu), on laptops a side menu.
 */
export function AdminShell({ active, plain, children }: { active: AdminTab; plain?: boolean; children: (session: Session) => ReactNode }) {
  const session = useSession();

  useEffect(() => {
    if (session && !isAdmin(session)) location.href = withBase('/');
  }, [session]);

  if (!session || !isAdmin(session)) return <PageSkeleton />;
  const current = TABS.find((t) => t.key === active)!;
  const title = current.label;

  return (
    <AppFrame session={session} active="admin" width="wide">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <nav className="sticky top-20 grid gap-0.5" aria-label="Manager pages">
            {TABS.filter((t) => (!t.hidden || t.key === active) && (t.key !== 'registry' || isDev(session))).map((t) => (
              <Link key={t.key} href={t.href} aria-current={t.key === active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 text-sm ${t.key === active ? 'bg-accent-soft font-medium text-accent' : 'text-fg hover:bg-subtle'}`}>
                <t.icon size={18} aria-hidden /> {t.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-5">
          {active !== 'overview' && !plain && (
            <div className="grid gap-1">
              <Link href="/admin" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg lg:hidden"><ArrowLeft size={14} /> Dashboard</Link>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight"><current.icon size={22} className="text-accent" aria-hidden /> {title}</h1>
            </div>
          )}
          {children(session)}
        </div>
      </div>
    </AppFrame>
  );
}

/** A titled card used by the admin pages. */
export function Panel({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

/** A button that needs a second tap to act, for actions that are hard to undo. */
export function ConfirmButton({ children, confirmLabel = 'Sure?', onConfirm, disabled, variant = 'secondary', className }: {
  children: ReactNode; confirmLabel?: string; onConfirm: () => void; disabled?: boolean; variant?: 'secondary' | 'danger' | 'primary'; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button variant={armed ? 'danger' : variant} disabled={disabled} className={className}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {armed ? confirmLabel : children}
    </Button>
  );
}

export function Badge({ children, tone = 'info' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info' }) {
  const c = { ok: 'bg-ok-soft text-ok', warn: 'bg-warn-soft text-warn', bad: 'bg-bad-soft text-bad', info: 'bg-subtle text-muted' }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
}

/** One-line result of the last action on a page. */
export function Notice({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="rounded-xl bg-subtle px-3 py-2 text-sm" role="status">{text}</p>;
}
