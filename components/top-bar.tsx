'use client';

import { withBase } from '@/lib/base';
import {
  Bell, Check, DoorOpen, Eye, LayoutDashboard, Moon, Plus, Sun, UserRound, Users, Utensils, WifiOff, X, type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { refreshPush, registerServiceWorker } from '@/lib/push';
import { signOut } from '@/lib/session';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { noteParts, type Note } from '@/lib/notes';
import { dhakaToday, timeRange } from '@/lib/format';
import { rpc, serverReachable } from '@/lib/rpc';
import { isAdmin, type Session } from '@/lib/session';
import { pollWhileVisible } from '@/lib/poll';
import { startDelay } from '@/lib/use-load';

export type Active = 'admin' | 'new' | 'attendant' | 'me' | 'profile' | 'mess';
type Item = { key: Active; href: string; label: string; icon: LucideIcon; center?: boolean };

/**
 * The tabs, kept to three:
 * - students: Meals · Mess · Profile;
 * - mess managers and devs: Dashboard · + (new meal) · Mess, with the profile behind the photo (top right);
 * - door staff: Door · Mess · Profile.
 */
function tabsFor(s: Session): Item[] {
  const profile: Item = { key: 'profile', href: '/me/profile', label: 'Profile', icon: UserRound };
  const mess: Item = { key: 'mess', href: '/mess', label: 'Mess', icon: Users };
  if (isAdmin(s)) {
    return [
      { key: 'admin', href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
      { key: 'new', href: '/admin/meals', label: 'New meal', icon: Plus, center: true },
      mess,
    ];
  }
  if (s.role === 'ATTENDANT') return [{ key: 'attendant', href: '/attendant', label: 'Door', icon: DoorOpen }, mess, profile];
  return [{ key: 'me', href: '/me', label: 'Meals', icon: Utensils }, mess, profile];
}

// Only managers use the new-meal form: its code is fetched when + is first tapped, not on every phone.
const NewMealSheet = dynamic(() => import('@/components/new-meal').then((m) => m.NewMealSheet), { ssr: false });

// Once per app start, not on every screen: register the service worker and this phone for notifications.
let started = false;

/**
 * The frame of every signed-in page: a slim header (logo, links on wider
 * screens, notifications, profile) and, on phones, a bottom tab bar.
 */
export function AppFrame({ session, active, width = 'narrow', children }: {
  session: Session; active?: Active; width?: 'narrow' | 'wide' | 'feed'; children: ReactNode;
}) {
  useEffect(() => {
    if (started) return;
    started = true;
    // The service worker makes the app installable, keeps its files on the phone and receives push notifications.
    registerServiceWorker().then(() => refreshPush()).catch(() => undefined);
    // Signed in without "Stay signed in", and the browser was closed since: sign out.
    try {
      if (localStorage.getItem('aula-temp-session') === '1' && !sessionStorage.getItem('aula-alive')) {
        localStorage.removeItem('aula-temp-session');
        signOut().finally(() => { location.href = withBase('/login'); });
      }
    } catch { /* private mode */ }
  }, []);
  const tabs = tabsFor(session);
  const home = tabs[0].href;
  const [adding, setAdding] = useState(false);
  return (
    <div className="min-h-dvh">
      <header className="bar-shadow sticky top-0 z-30 border-b border-border/70 bg-bg/95 pt-[env(safe-area-inset-top)]">
        <div className="relative mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          {/* The hall's name, centred (on wider screens the links take the middle). */}
          <span className="font-display pointer-events-none absolute left-1/2 -translate-x-1/2 text-[1.125rem] font-bold tracking-tight max-[379px]:left-[3.6rem] max-[379px]:translate-x-0 max-[379px]:text-[1.0625rem] md:hidden">Aula North</span>
          <Link href={home} aria-label="Home" className="flex items-center gap-2 font-semibold">
            <span className="flex size-9 items-center justify-center rounded-[0.8rem] bg-gradient-to-br from-glow to-accent text-accent-fg shadow-[0_6px_16px_-6px_var(--glow)] ring-1 ring-white/20 ring-inset"><Utensils size={18} strokeWidth={2.3} /></span>
            <span className="font-display hidden text-[1.0625rem] font-bold tracking-tight sm:inline">Aula Dining</span>
          </Link>
          <nav className="ml-4 hidden items-center gap-1 text-sm md:flex" aria-label="Main">
            {tabs.map((it) => it.center ? (
              <button key={it.key} type="button" onClick={() => setAdding(true)}
                className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 font-medium text-accent-fg">
                <Plus size={15} />{it.label}
              </button>
            ) : (
              <Link key={it.key} href={it.href} aria-current={active === it.key ? 'page' : undefined}
                className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 ${active === it.key ? 'bg-fg font-semibold text-bg' : 'font-medium text-muted hover:text-fg'}`}>
                {it.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <ThemeSwitch />
            <Notifications admin={isAdmin(session)} />
            <Link href="/me/profile" aria-label="Profile" title={session.name || 'Profile'}
              className={`flex items-center gap-2 rounded-full p-1 md:pr-3 ${active === 'profile' ? 'bg-subtle ring-2 ring-accent/50' : 'hover:bg-subtle'}`}>
              {session.avatar_url
                ? <img src={session.avatar_url} alt="" className="size-8 rounded-full object-cover" />
                : <span className="flex size-8 items-center justify-center rounded-full bg-subtle text-muted"><UserRound size={17} /></span>}
              <span className="hidden max-w-36 truncate text-sm md:inline">{session.name || 'Profile'}</span>
            </Link>
          </div>
        </div>
        {session.view_only && (
          <p className="border-t border-border bg-accent-soft px-4 py-1.5 text-center text-xs text-fg">
            <Eye size={13} className="mr-1 inline align-[-2px]" aria-hidden />
            <b>View-only account.</b> Open anything you like; buttons won’t change any data.
          </p>
        )}
      </header>

      <main className={`mx-auto grid w-full grid-cols-[minmax(0,1fr)] gap-4 px-4 pb-32 pt-4 md:pb-12 md:pt-6 ${width === 'wide' ? 'max-w-6xl' : width === 'feed' ? 'max-w-3xl lg:max-w-6xl' : 'max-w-3xl'}`}>
        {children}
      </main>

      <nav aria-label="Tabs"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border/70 bg-surface/[0.97] pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_30px_-24px_rgb(0_0_0/0.5)] md:hidden">
        {tabs.map((t) => {
          const on = active === t.key;
          if (t.center) {
            return (
              <button key={t.key} type="button" onClick={() => setAdding(true)} aria-label={t.label} aria-haspopup="dialog"
                className="flex flex-col items-center justify-end pb-1.5">
                <span className="-mt-6 flex size-14 items-center justify-center rounded-full bg-gradient-to-br from-glow to-accent text-accent-fg shadow-[0_10px_24px_-8px_var(--glow)] ring-4 ring-surface transition active:scale-95">
                  <Plus size={28} strokeWidth={2.4} />
                </span>
                <span className="mt-0.5 text-[0.6875rem] text-muted">{t.label}</span>
              </button>
            );
          }
          return (
            <Link key={t.key} href={t.href} aria-current={on ? 'page' : undefined}
              className={`relative flex flex-col items-center gap-1 pb-2 pt-2 text-[0.6875rem] tracking-wide transition active:scale-95 ${on ? 'font-semibold text-accent' : 'font-medium text-muted'}`}>
              <span className={`flex h-8 w-14 items-center justify-center rounded-full ${on ? 'pop-in bg-accent-soft' : ''}`}>
                <t.icon size={21} strokeWidth={on ? 2.4 : 1.8} />
              </span>
              {t.label}
            </Link>
          );
        })}
      </nav>
      {adding && <NewMealSheet onClose={() => setAdding(false)} />}
      <OfflinePill />
    </div>
  );
}

/** Kept for pages that only need the header; prefer AppFrame. */
export const TopBar = AppFrame;

const SEEN_KEY = 'aula.notes.seen';

type Bell = { at: number; admin: boolean; notes: Note[]; claims: Claim[]; names: NameReq[]; sids: unknown[] };
let bell: Bell | null = null;

type Claim = { claim_id: string; kind: 'INITIAL' | 'CHANGE'; coupon_number: number; claimed_name: string; requested_at: string };
type NameReq = { request_id: string; coupon_number: number | null; old_name: string | null; new_name: string; register_name: string | null };

/**
 * The bell: recent notifications in a small panel, with a dot when something
 * new arrived. Admins also see coupon claims waiting for approval, with a count.
 */
function Notifications({ admin }: { admin: boolean }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [names, setNames] = useState<NameReq[]>([]);
  const [sids, setSids] = useState<unknown[]>([]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<string>('');
  const box = useRef<HTMLDivElement>(null);

  // Remembered across screens (every page builds its own top bar): switching tabs asks nothing.
  const apply = (b: Bell) => { setNotes(b.notes); setClaims(b.claims); setNames(b.names); setSids(b.sids); };
  const load = async () => {
    const [n, c, nm, sd] = await Promise.all([
      rpc<Note[]>('my_notifications', { p_limit: 15 }).catch(() => bell?.notes ?? []),
      admin ? rpc<Claim[]>('admin_coupon_claims').catch(() => bell?.claims ?? []) : [],
      admin ? rpc<NameReq[]>('admin_name_requests').catch(() => bell?.names ?? []) : [],
      admin ? rpc<unknown[]>('admin_student_id_requests').catch(() => bell?.sids ?? []) : [],
    ]);
    bell = { at: Date.now(), admin, notes: n, claims: c, names: nm, sids: sd };
    apply(bell);
  };

  useEffect(() => {
    try { setSeen(localStorage.getItem(SEEN_KEY) ?? ''); } catch { /* private mode */ }
    if (bell && bell.admin === admin) apply(bell);
    // Students: every 5 minutes (push notifications bring the urgent ones at once) and when the bell
    // is tapped; the first load a few seconds after opening. Mess managers: every 30 s (claims to verify).
    const every = admin ? 30000 : 5 * 60000;
    const due = !bell || bell.admin !== admin || Date.now() - bell.at > every;
    let stop: (() => void) | undefined;
    const t = setTimeout(() => { if (due) load(); stop = pollWhileVisible(load, every); }, due && !admin && !bell ? startDelay() : 0);
    return () => { clearTimeout(t); stop?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const decideName = async (id: string, approve: boolean) => {
    await rpc('decide_name_change', { p_request_id: id, p_approve: approve }).catch(() => undefined);
    await load();
  };
  const waiting = claims.length + names.length + sids.length;
  const newest = notes[0]?.created_at ?? '';
  const unread = newest !== '' && newest > seen;
  // What was already seen when the panel opened, so the new ones keep their dot while it is open.
  const [seenBefore, setSeenBefore] = useState('');
  const toggle = () => {
    setOpen(!open);
    if (!open && (!bell || Date.now() - bell.at > 30000)) load();
    if (!open) setSeenBefore(seen);
    if (!open && newest) {
      setSeen(newest);
      try { localStorage.setItem(SEEN_KEY, newest); } catch { /* private mode */ }
    }
  };

  return (
    <div ref={box} className="relative">
      <button onClick={toggle} aria-label={waiting ? `Notifications, ${waiting} waiting for you` : 'Notifications'}
        aria-expanded={open} className="relative rounded-full p-2 text-muted hover:bg-subtle">
        <Bell size={20} />
        {waiting > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-accent px-1 text-[0.6875rem] font-semibold text-accent-fg">
            {waiting}
          </span>
        ) : unread && <span className="absolute right-1.5 top-1.5 size-2.5 rounded-full border-2 border-bg bg-accent" />}
      </button>
      {open && (
        <div className="pop-open fixed inset-x-3 top-16 z-40 rounded-3xl border border-border bg-surface p-2 shadow-[var(--lift),0_24px_48px_-20px_rgb(0_0_0/0.35)] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-[22rem]">
          {claims.length > 0 && (
            <div className="mb-2 rounded-xl bg-accent-soft p-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-sm font-semibold">Claims waiting · {claims.length}</p>
                <Link href="/admin/claims" onClick={() => setOpen(false)} className="text-sm font-medium text-accent">Review all</Link>
              </div>
              <ul className="mt-1 grid gap-0.5">
                {claims.slice(0, 4).map((c) => (
                  <li key={c.claim_id}>
                    <Link href="/admin/claims" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm hover:bg-surface">
                      <b className="tabular-nums">{c.coupon_number}</b><span className="min-w-0 flex-1 truncate">{c.claimed_name}</span>
                      <span className="text-xs text-muted">{c.kind === 'CHANGE' ? 'change' : 'new'}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {names.length > 0 && (
            <div className="mb-2 rounded-xl bg-accent-soft p-2">
              <p className="px-1 text-sm font-semibold">Name changes · {names.length}</p>
              <ul className="mt-1 grid gap-1">
                {names.map((n) => (
                  <li key={n.request_id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm">
                    <b className="tabular-nums">{n.coupon_number ?? '—'}</b>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate"><span className="text-muted line-through">{n.old_name}</span> → {n.new_name}</span>
                      {n.register_name && <span className="block truncate text-xs text-muted">Hall list: {n.register_name}</span>}
                    </span>
                    <button onClick={() => decideName(n.request_id, false)} aria-label={`Decline name ${n.new_name}`}
                      className="rounded-full p-1.5 text-muted hover:bg-surface"><X size={16} /></button>
                    <button onClick={() => decideName(n.request_id, true)} aria-label={`Approve name ${n.new_name}`}
                      className="rounded-full bg-accent p-1.5 text-accent-fg"><Check size={16} /></button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {sids.length > 0 && (
            <Link href="/admin/claims" onClick={() => setOpen(false)} className="mb-2 flex items-center justify-between rounded-xl bg-accent-soft p-3 text-sm">
              <span className="font-semibold">Student ID changes · {sids.length}</span><span className="font-medium text-accent">Verify</span>
            </Link>
          )}
          <p className="font-display px-3 pb-1 pt-2 text-base font-bold">Notifications</p>
          {notes.length === 0 ? <p className="px-3 py-3 text-sm text-muted">Nothing yet.</p> : (
            <ul className="max-h-[22rem] divide-y divide-border/60 overflow-y-auto px-1">
              {notes.map((n) => {
                const { title, detail } = noteParts(n);
                const fresh = n.created_at > seenBefore;
                return (
                  <li key={n.id} className="flex items-start gap-2.5 px-2 py-2.5">
                    <span className={`mt-[0.45rem] size-1.5 shrink-0 rounded-full ${fresh ? 'bg-accent' : 'bg-transparent'}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className={`min-w-0 truncate text-sm ${fresh ? 'font-semibold' : 'font-medium'}`}>{title}</p>
                        <span className="shrink-0 text-[0.6875rem] text-muted">{when(n.created_at)}</span>
                      </div>
                      {detail && <p className="mt-0.5 line-clamp-2 text-[0.8125rem] leading-snug text-muted">{detail}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "8:17 pm" today, "Yesterday", or "16 Nov". */
function when(iso: string) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(iso));
  const today = dhakaToday();
  if (day === today) return timeRange(iso);
  const y = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(Date.now() - 86400000));
  if (day === y) return 'Yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short' });
}

/** A quiet sun/moon button: one tap swaps light (white & black) and dark (ocean blue); remembered on this device. */
function ThemeSwitch() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setDark(t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);
  if (dark === null) return null;
  const flip = () => {
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('aula-theme', next); } catch { /* private mode */ }
    setDark(!dark);
  };
  return (
    <button onClick={flip} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Light theme' : 'Dark theme'}
      className="rounded-full p-2 text-muted opacity-70 hover:bg-subtle hover:opacity-100">
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

/**
 * A small pill while the phone can't reach the server: screens keep showing what is saved on the
 * phone, and everything refreshes by itself when the connection is back.
 */
function OfflinePill() {
  const [down, setDown] = useState(false);
  useEffect(() => {
    const check = () => setDown(!navigator.onLine || !serverReachable());
    check();
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    window.addEventListener('aula-reach', check);
    return () => {
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
      window.removeEventListener('aula-reach', check);
    };
  }, []);
  if (!down) return null;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex justify-center md:bottom-4">
      <span className="flex items-center gap-1.5 rounded-full bg-fg px-3 py-1.5 text-xs font-medium text-bg shadow-lg">
        <WifiOff size={13} /> No connection · showing saved info
      </span>
    </div>
  );
}
