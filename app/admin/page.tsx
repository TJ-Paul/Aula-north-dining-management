'use client';

import { withBase } from '@/lib/base';
import { resetDemo } from '@/lib/demo/engine';
import { forgetCache } from '@/lib/use-load';
import {
  BadgeCheck, ChevronDown, ChevronRight, ChevronUp, ClipboardCheck, Database, DoorOpen, FastForward, FileSpreadsheet, Flag, Megaphone, MessageSquareText, Eye,
  History, Play, Plus, RotateCcw, Sparkles, Trash2, UserCheck, Users, type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { AdminShell, ConfirmButton } from '@/components/admin-shell';
import { AppSetup } from '@/components/app-setup';
import { GateControl } from '@/components/gate-control';
import { mealLabel, type MealBrief } from '@/components/meal-card';
import type { QuickKind } from '@/components/meal-editor';
import { Button } from '@/components/sheet';
import { LOCAL_MODE, mealsLive, rpc, testingTool } from '@/lib/rpc';
import { dhakaToday, timeRange } from '@/lib/format';
import { isDev, type Session } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

export default function AdminPage() {
  return <AdminShell active="overview">{(s) => <Dashboard session={s} />}</AdminShell>;
}

/**
 * The mess managers' dashboard, in three parts:
 * 1. Collect coupons and Announcement, side by side;
 * 2. the gate of today's improvement, feast or paron (from an hour before it starts);
 * 3. everything else as small buttons.
 */
function Dashboard({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  // The last demo tool's result, kept over the page reload that shows its effect everywhere.
  const [note, setNote] = useState<string | null>(() => {
    try { const n = sessionStorage.getItem('aula-demo-note'); sessionStorage.removeItem('aula-demo-note'); return n; } catch { return null; }
  });
  const [gateLive, setGateLive] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // Coupon claims plus name and student ID changes: everything waiting to be verified.
  const claims = useLoad(() => Promise.all([rpc<unknown[]>('admin_coupon_claims'), rpc<unknown[]>('admin_name_requests'),
    rpc<unknown[]>('admin_student_id_requests')]).then((l) => l.flat()), 60000, { cache: 'dash-claims' });
  const feedback = useLoad(() => rpc<Array<{ status: string }>>('list_feedback', { p_mess_month_id: null, p_include_resolved: false }), 60000,
    { lazy: true, cache: 'dash-feedback' });
  const waitingClaims = claims.data?.length ?? 0;
  const newFeedback = feedback.data?.filter((f) => f.status === 'NEW').length ?? 0;
  const waiting = waitingClaims + newFeedback;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = await fn();
      // The dashboard, gate controls and lists all refresh at once (a fresh page load: everything re-reads).
      try { sessionStorage.setItem('aula-demo-note', `${label}: ${summarise(r)}`); } catch { /* private mode */ }
      forgetCache();
      location.reload();
      return;
    } catch (e) {
      setNote(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const today = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{greeting()}</p>
          <h1 className="text-balance text-[clamp(1.2rem,6.3vw,1.5rem)] font-semibold tracking-tight">{today}</h1>
        </div>
        <span className="shrink-0 whitespace-nowrap rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent">{isDev(session) ? 'Dev' : 'Mess manager'}</span>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <BigButton href="/attendant" icon={DoorOpen} label="Collect coupons" sub="Door" primary />
        <BigButton href="/admin/announcements" icon={Megaphone} label="Announcement" sub="To everyone" />
      </section>

      <GateControl onLive={setGateLive} />

      {/* On a special meal's day (gate running) Today folds into More with the rest. */}
      {!gateLive && <TodayMeals />}

      <AppSetup compact />

      {/* During a special meal the gate comes first: the other pages fold into one bar (with any waiting count). */}
      {gateLive && !showMore ? (
        <button type="button" onClick={() => setShowMore(true)}
          className="card flex items-center justify-between gap-3 !py-3 text-sm font-medium text-fg/80 hover:text-fg">
          <span className="flex items-center gap-2">More
            {waiting > 0 && <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-fg">{waiting}</span>}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted">Today, Attendance, Database… <ChevronDown size={16} aria-hidden /></span>
        </button>
      ) : (
      <section aria-label="More">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">More</h2>
          {gateLive && (
            <button type="button" onClick={() => setShowMore(false)}
              className="flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted hover:bg-subtle hover:text-fg">
              Hide <ChevronUp size={14} aria-hidden />
            </button>
          )}
        </div>
        {gateLive && <div className="mb-2.5"><TodayMeals /></div>}
        {/* All meals across the top, the rest two by two (a fifth one, the dev's Hall register, takes a full row). */}
        <div className="grid grid-cols-2 gap-2.5">
          <Small href="/admin/meals" icon={History} label="All meals" wide />
          <Small href="/admin/attendance" icon={ClipboardCheck} label="Attendance" />
          <Small href="/admin/everyone" icon={Database} label="Database" />
          <Small href="/admin/review" icon={MessageSquareText} label="Feedback" count={newFeedback} />
          <Small href="/admin/claims" icon={BadgeCheck} label="Claims" count={waitingClaims} />
          {isDev(session) && <Small href="/admin/registry" icon={FileSpreadsheet} label="Hall register" wide />}
        </div>
      </section>
      )}

      {LOCAL_MODE && (
        <section className="rounded-2xl border border-dashed border-border p-4">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><Sparkles size={16} /> Demo tools</h2>
          <p className="mb-3 text-sm text-muted">
            Try a whole special meal in a few minutes: start a demo feast (booking opens 5 min before the start), let a
            crowd of made-up students book, then press Filled → Start taking bookings → Gate open, just like the mess
            managers do. Switch to the student account (top of the page) to see the same meal from a student’s phone.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => run('Demo feast', () => testingTool({ action: 'new_dinner', startInMinutes: 6, prebook: 0 }))}>
              <span className="flex items-center gap-2"><RotateCcw size={16} /> Start a demo feast (in 6 min)</span></Button>
            <Button disabled={busy} onClick={() => run('Bookings', () => testingTool({ action: 'simulate_bookings', count: 20 }))}>
              <span className="flex items-center gap-2"><Plus size={16} /> 20 students book</span></Button>
            <Button disabled={busy} onClick={() => run('Skip', () => testingTool({ action: 'skip_ahead', minutes: 1 }))}>
              <span className="flex items-center gap-2"><FastForward size={16} /> Skip 1 min</span></Button>
            <Button disabled={busy} onClick={() => run('Skip', () => testingTool({ action: 'skip_ahead', minutes: 3 }))}>
              <span className="flex items-center gap-2"><FastForward size={16} /> Skip 3 min</span></Button>
            <Button disabled={busy} onClick={() => run('Door', () => testingTool({ action: 'simulate_arrivals', count: 10 }))}>
              <span className="flex items-center gap-2"><UserCheck size={16} /> 10 booked students come in</span></Button>
            <Button disabled={busy} onClick={() => run('Filled', () => testingTool({ action: 'load_batch' }))}>
              <span className="flex items-center gap-2"><Flag size={16} /> Filled</span></Button>
            <Button disabled={busy} onClick={() => run('Bookings', () => testingTool({ action: 'open_next_booking' }))}>
              <span className="flex items-center gap-2"><Plus size={16} /> Start taking bookings</span></Button>
            <Button disabled={busy} onClick={() => run('Gate', () => testingTool({ action: 'start_next_batch' }))}>
              <span className="flex items-center gap-2"><Play size={16} /> Gate open</span></Button>
            <Button disabled={busy} onClick={() => run('End of dinner', () => testingTool({ action: 'end_dinner' }))}>
              <span className="flex items-center gap-2"><Flag size={16} /> End dinner</span></Button>
            <ConfirmButton disabled={busy}
              onConfirm={() => run('Reset', async () => { await resetDemo(); location.href = withBase('/login'); })}>
              <span className="flex items-center gap-2"><Trash2 size={16} /> Reset the demo data</span>
            </ConfirmButton>
          </div>
          {note && <p className="mt-3 text-sm text-muted">{note}</p>}
        </section>
      )}
    </>
  );
}

// The new-meal and edit forms are only fetched when Lunch + / Dinner + / Edit is tapped.
const NewMealSheet = dynamic(() => import('@/components/new-meal').then((m) => m.NewMealSheet), { ssr: false });
const EditMealSheet = dynamic(() => import('@/components/edit-meal-sheet').then((m) => m.EditMealSheet), { ssr: false });

const dhakaDay = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(iso));

/**
 * Today at a glance: each of today's meals with where it stands, a Close button for a meal that is running,
 * and Lunch + / Dinner + when that meal hasn't been added. Reads the same cached list as the students'
 * Meals tab, so it costs the database nothing extra.
 */
function TodayMeals() {
  const list = useLoad(() => mealsLive<{ meals: MealBrief[] }>().then((r) => r.meals), 60000, { cache: 'dash-today' });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<QuickKind | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const today = dhakaToday();
  // Cancelled meals are left out entirely (Lunch + / Dinner + come back if one was cancelled).
  const meals = (list.data ?? []).filter((m) => m.state !== 'CANCELLED' && dhakaDay(m.service_start_at) === today)
    .sort((a, b) => b.service_start_at.localeCompare(a.service_start_at)); // dinner first
  const has = (t: string) => meals.some((m) => m.meal_type === t);

  const close = async (m: MealBrief) => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string }>('set_meal_service_state', { p_meal_service_id: m.id, p_target: 'CLOSED', p_reason: 'Closed by admin' });
      if (r.status === 'OK' || r.status === 'UNCHANGED') { setClosed((c) => new Set(c).add(m.id)); setMsg(null); }
      else setMsg(r.status.replaceAll('_', ' ').toLowerCase());
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (list.data === undefined) return <section className="card h-24 animate-pulse" aria-hidden />;
  return (
    <section className="card grid grid-cols-[minmax(0,1fr)] gap-1 !py-3" aria-label="Today's meals">
      <div className="flex items-center justify-between gap-2 px-0.5 pb-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Today</h2>
        {/* The students' Meals screen, as they see it. */}
        <Link href="/admin/student-view" aria-label="Student view" title="Student view"
          className="-my-1.5 -mr-1.5 flex size-9 items-center justify-center rounded-full text-accent transition hover:bg-subtle active:scale-95">
          <Eye size={19} aria-hidden />
        </Link>
      </div>
      {meals.map((m) => {
        const state = closed.has(m.id) ? 'CLOSED' : m.state;
        const running = state === 'IN_SERVICE';
        const ended = state === 'CLOSED';
        return (
          <div key={m.id} className="flex min-h-11 items-center gap-3 border-t border-border/70 py-2 first-of-type:border-t-0">
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold leading-tight">{mealLabel(m)}</p>
              {!ended && (
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                  {running && <span className="live-dot [--dot:var(--ok)]" aria-hidden />}
                  <span className={running ? 'font-semibold text-ok' : ''}>{running ? 'Serving now' : timeRange(m.service_start_at)}</span>
                </p>
              )}
              {!!m.menu?.length && (
                <p className="mt-1 truncate text-xs text-muted/80">{m.menu.map((d) => d.replace(/ \(or .*\)$/, '')).join(' · ')}</p>
              )}
            </div>
            {ended && (
              <span className="shrink-0 self-start rounded-full bg-subtle px-2.5 py-0.5 text-xs font-medium text-muted">
                Closed
              </span>
            )}
            {/* Once the meal's time is over (its end, or its start if it has none): Close, left of Edit. */}
            {state !== 'CLOSED' && new Date(m.service_end_at ?? m.service_start_at).getTime() <= Date.now() && (
              <ConfirmButton disabled={busy} className="lift-soft" onConfirm={() => close(m)}>Close</ConfirmButton>
            )}
            {state !== 'CLOSED' && (
              <button type="button" onClick={() => setEditingId(m.id)}
                className="lift-soft flex min-h-12 items-center rounded-2xl border border-border bg-surface px-4 font-semibold hover:bg-subtle">Edit</button>
            )}
          </div>
        );
      })}
      {(!has('LUNCH') || !has('DINNER')) && (
        <div className={`flex gap-2 ${meals.length ? 'border-t border-border/70 pt-3' : ''}`}>
          {!has('LUNCH') && <Button className="lift-soft flex-1 !min-h-[4.75rem] text-[clamp(1.05rem,5.2vw,1.25rem)]" onClick={() => setAdding('LUNCH')}>Lunch +</Button>}
          {!has('DINNER') && <Button className="lift-soft flex-1 !min-h-[4.75rem] text-[clamp(1.05rem,5.2vw,1.25rem)]" onClick={() => setAdding('DINNER')}>Dinner +</Button>}
        </div>
      )}
      {/* Lunch + / Dinner + are tapped nearly every day, so they are the big ones. An improvement or feast is the day's dinner: offered while there is no dinner yet. */}
      {!has('DINNER') && (
        <div className="grid gap-2 pt-2">
          <Button className="w-full !min-h-10 text-sm !border-gold/40 !text-gold" onClick={() => setAdding('IMPROVEMENT')}>Improvement +</Button>
          <Button className="w-full !min-h-10 text-sm !border-warn/40 !text-warn" onClick={() => setAdding('FEAST')}>Feast +</Button>
        </div>
      )}
      {msg && <p className="pt-1 text-sm text-bad" role="status">{msg}</p>}
      {editingId && <EditMealSheet mealId={editingId} onClose={() => setEditingId(null)} onChanged={() => setTimeout(list.reload, 1500)} />}
      {adding && <NewMealSheet type={adding} onClose={() => setAdding(null)} onCreated={() => setTimeout(list.reload, 1500)} />}
    </section>
  );
}

function BigButton({ href, icon: Icon, label, sub, primary }: { href: string; icon: LucideIcon; label: string; sub: string; primary?: boolean }) {
  return (
    <Link href={href}
      className={`group relative flex min-h-32 flex-col justify-between overflow-hidden rounded-3xl p-4 shadow-sm transition active:scale-[0.98] ${primary
        ? 'big-btn-primary bg-gradient-to-br from-accent to-accent/80 text-accent-fg shadow-accent/25'
        : 'big-btn border border-border bg-surface'}`}>
      <span className={`flex size-11 items-center justify-center rounded-2xl ${primary ? 'bg-white/20' : 'bg-accent-soft text-accent'}`}><Icon size={22} /></span>
      <span>
        <span className="block text-balance text-[clamp(0.85rem,4.55vw,1.125rem)] font-semibold leading-tight">{label}</span>
        <span className={`flex items-center gap-1 text-xs ${primary ? 'opacity-85' : 'text-muted'}`}>{sub} <ChevronRight size={13} className="transition group-hover:translate-x-0.5" /></span>
      </span>
    </Link>
  );
}

/** A tile: the icon fills its left side (like the date on meal cards), the name beside it. `wide`: a full row. */
function Small({ href, icon: Icon, label, count, wide }: { href: string; icon: LucideIcon; label: string; count?: number; wide?: boolean }) {
  return (
    <Link href={href} className={`card relative flex min-h-14 items-stretch overflow-hidden !p-0 transition hover:bg-subtle active:scale-[0.97] ${wide ? 'col-span-2' : ''}`}>
      <span className="flex w-[clamp(2.75rem,13vw,3.5rem)] shrink-0 items-center justify-center bg-subtle text-accent" aria-hidden><Icon size={19} /></span>
      <span className="flex min-w-0 flex-1 items-center px-[clamp(0.6rem,3vw,0.9rem)] py-3 text-[clamp(0.8rem,4vw,0.9375rem)] font-medium leading-tight">{label}</span>
      {!!count && (
        <span className="mr-2.5 flex min-w-5 items-center justify-center self-center rounded-full bg-accent px-1.5 text-[0.6875rem] font-semibold text-accent-fg">{count}</span>
      )}
    </Link>
  );
}

function summarise(r: unknown): string {
  if (!r || typeof r !== 'object') return 'done';
  const x = r as Record<string, unknown>;
  if (x.jobs && typeof x.jobs === 'object') {
    const j = x.jobs as Record<string, number>;
    const parts = [
      j.batches_started && 'batch started', j.seats_released && `${j.seats_released} seats given back (time ran out)`,
      j.rewards_given && `${j.rewards_given} reward points given`,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : 'nothing due';
  }
  if (x.status === 'LOADED') return `batch ${x.batch} loaded: ${x.arrived} ate; batch ${x.next_batch} booking open`;
  if (x.status === 'STARTED') return 'next batch started';
  if (x.status === 'MEAL_IN_PROGRESS') return 'a real meal is in progress today; end it first';
  if ('created' in x) return `${x.created} test students created (password ${String(x.password)})`;
  if ('booked' in x) return `${x.booked} booked`;
  if ('arrived' in x) return `${x.arrived} came in`;
  return String(x.status ?? 'done').toLowerCase();
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: 'numeric', hour12: false }).format(new Date()));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
