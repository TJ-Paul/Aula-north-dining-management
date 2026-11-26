'use client';

import { withBase } from '@/lib/base';
import {
  BadgeCheck, BedDouble, Check, ChevronRight, Crown, KeyRound, Lightbulb, LogOut, Pencil, Trash2, UserRound, X,
} from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { AppSetup, NotificationsRow } from '@/components/app-setup';
import { CouponStatus } from '@/components/coupon-status';
import { TextSizeButton } from '@/components/text-size';
import { HistoryCard, type EarlierHolder, type PersonHistory } from '@/components/history';
import { type PersonCard } from '@/components/person';
import { Button, Sheet } from '@/components/sheet';
import { PageSkeleton } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { dateSpan, titleCase } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { ROLE_LABEL, accountRoute, authAction, signOut, useSessionWithReload, type Session } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

type Linked = PersonCard & { link_id: string };
export type RoommateData = { accepted: Linked[]; incoming: Linked[]; outgoing: Linked[] };

/**
 * Profile: the student's details as one tidy card (easy to screenshot and share), then
 * My Meals and the settings. Details rarely change, so editing sits behind "Edit profile".
 */
export default function ProfilePage() {
  const { session, reload } = useSessionWithReload();
  const roommates = useLoad(session?.coupon_number ? () => rpc<RoommateData>('my_roommates') : null, undefined, { cache: 'roommates', fresh: 5 * 60000 });
  if (!session) return <PageSkeleton />;

  return (
    <AppFrame session={session} active="profile">
      <IdCard session={session} roommates={roommates.data?.accepted ?? []} />
      <ManagerRecord />
      {roommates.data && roommates.data.incoming.length > 0 && <RoommateRequests list={roommates.data.incoming} onChanged={roommates.reload} />}

      {session.role === 'STUDENT' && (!session.coupon_number || session.update_requested_at || session.pending_claim) && (
        <CouponStatus session={session} onChanged={reload} compact />
      )}

      {session.role === 'STUDENT' && <MyHistory />}

      {/* Both show only while something is left to do (app not installed, notifications off). */}
      <AppSetup />
      <NotificationsRow />

      <ChangePassword />
      <DeleteAccount />
    </AppFrame>
  );
}

/** Everything about the student in one card: photo, name, coupon, student ID, room, phone and roommates. */
function IdCard({ session: s, roommates }: { session: Session; roommates: Linked[] }) {
  const cells: Array<{ label: string; value: string | null; big?: boolean }> = [
    ...(s.coupon_number !== null ? [{ label: 'Coupon', value: String(s.coupon_number), big: true }] : []),
    { label: 'Room', value: s.room },
  ];
  return (
    <section className="relative overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
      <div className="relative bg-gradient-to-b from-accent/25 via-accent/5 to-surface px-5 pb-4 pt-4">
        <span className="pointer-events-none absolute -right-8 -top-10 size-40 rounded-full bg-accent/15 blur-2xl" aria-hidden />
        <div className="relative flex justify-between gap-2">
          <div className="flex gap-2">
            <Link href="/me/how" aria-label="How it works" title="How it works" className="flex size-9 items-center justify-center rounded-full bg-surface/80 text-warn shadow-sm">
              <Lightbulb size={17} />
            </Link>
            <TextSizeButton />
          </div>
          <Link href="/me/profile/edit" className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface/80 px-3 text-sm font-medium shadow-sm">
            <Pencil size={14} /> Edit profile
          </Link>
        </div>
        <div className="relative mt-2 flex flex-col items-center text-center">
          {s.avatar_url
            ? <img src={s.avatar_url} alt="" className="size-32 rounded-[2rem] object-cover shadow-lg ring-4 ring-surface" />
            : <span className="flex size-32 items-center justify-center rounded-[2rem] bg-surface text-muted shadow-lg ring-4 ring-surface"><UserRound size={52} /></span>}
          <h1 className="mt-3 flex items-center gap-1.5 text-2xl font-semibold leading-tight tracking-tight">
            <span className="break-words">{titleCase(s.name) || 'No name yet'}</span>
            {s.coupon_number && <BadgeCheck size={20} className="shrink-0 text-ok" aria-label="Verified" />}
          </h1>
          {s.student_id && <p className="mt-1 text-sm tabular-nums tracking-wide text-muted">{s.student_id}</p>}
          {s.role !== 'STUDENT' && (
            <span className="mt-1.5 rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-fg">{ROLE_LABEL[s.role]}</span>
          )}
        </div>
      </div>

      <div className="grid gap-4 px-4 pb-5 pt-1">
        {/* One outlined panel split by hairlines; the coupon (the hall identity) in big coral figures. */}
        {/* Coupon and room: a label with its number in a tile below; the phone as a plain line. */}
        <dl className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            {cells.filter((c) => c.label !== 'Phone').map((c) => (
              <div key={c.label} className="min-w-0">
                <dt className="mb-1.5 text-center text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-muted">{c.label}</dt>
                {c.big ? (
                  // The coupon is also the way into My Meals (every meal this coupon ate).
                  <dd>
                    <Link href="/me/meals" aria-label={`Coupon ${c.value}: my meals`}
                      className="lift-soft font-display flex h-16 flex-col items-center justify-center rounded-2xl border border-accent/25 bg-accent-soft tabular-nums text-accent transition hover:border-accent/60 active:scale-[0.97]">
                      <span className="text-[2rem] font-extrabold leading-none">{c.value}</span>
                      <span className="mt-1 flex items-center gap-0.5 font-sans text-[0.6875rem] font-semibold">My meals <ChevronRight size={12} aria-hidden /></span>
                    </Link>
                  </dd>
                ) : (
                  <dd className="lift-soft font-display flex h-16 items-center justify-center rounded-2xl border border-border bg-subtle text-2xl font-bold tabular-nums">
                    {c.value || <span className="font-sans text-base font-normal text-muted">—</span>}
                  </dd>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-baseline justify-between gap-3 px-1">
            <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-muted">Phone</dt>
            <dd className="truncate text-sm font-semibold tabular-nums">{s.phone || <span className="font-normal text-muted">—</span>}</dd>
          </div>
        </dl>
        {s.coupon_number !== null && roommates.length > 0 && (
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted"><BedDouble size={13} /> Roommates</p>
            <ul className="grid gap-1.5">
              {roommates.map((r) => (
                <li key={r.link_id} className="flex items-center gap-2.5 rounded-xl bg-subtle px-2.5 py-1.5">
                  {r.avatar_url ? <img src={r.avatar_url} alt="" className="size-7 rounded-full object-cover" />
                    : <span className="flex size-7 items-center justify-center rounded-full bg-surface text-muted"><UserRound size={14} /></span>}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{titleCase(r.name) ?? '—'}</span>
                  <span className="shrink-0 text-xs text-muted tabular-nums">Coupon {r.coupon_number ?? '—'}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

type Served = {
  id: string; serial: number; name: string; starts_on: string; ends_on: string; banner_url: string | null;
  status: 'ACTIVE' | 'RETIRED';
};

/** The mess months they served as a mess manager: kept like an achievement, each opens its month. */
function ManagerRecord() {
  // The same answer the My Meals page keeps; asked for once, then shown at once.
  const { data } = useLoad(() => rpc<{ managed?: Served[] }>('my_extras'), undefined, { lazy: true, cache: 'my-extras', fresh: 5 * 60000 });
  const list = data?.managed ?? [];
  if (list.length === 0) return null;
  return (
    <section className="grid gap-2">
      <h2 className="flex items-center gap-2 px-1 text-sm font-semibold text-muted"><Crown size={16} className="text-warn" /> Mess manager</h2>
      {list.map((m) => (
        <Link key={m.id} href={`/mess/month/?month=${m.id}`} className="card flex items-center gap-3 !p-2.5 transition hover:bg-subtle active:scale-[0.99]">
          <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-gradient-to-br from-warn/30 to-accent/20">
            {m.banner_url
              ? <img src={m.banner_url} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
              : <Crown size={24} className="absolute inset-0 m-auto text-warn" aria-hidden />}
            <span className={`absolute right-1 top-1 flex size-6 items-center justify-center rounded-full text-xs font-bold tabular-nums ring-1 ${m.banner_url ? 'bg-black/50 text-white ring-white/60' : 'bg-surface/80 ring-warn/40'}`}>
              {m.serial}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{m.name}</span>
            <span className="block text-xs text-muted">Mess month {m.serial} · <span className="whitespace-nowrap">{dateSpan(m.starts_on, m.ends_on)}</span></span>
            <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${m.status === 'ACTIVE' ? 'bg-ok-soft text-ok' : 'bg-warn-soft text-warn'}`}>
              {m.status === 'ACTIVE' ? 'Serving now' : 'Served'}
            </span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-muted" />
        </Link>
      ))}
    </section>
  );
}

/** Someone asked to add this student as a roommate: accept or decline right here. */
function RoommateRequests({ list, onChanged }: { list: Linked[]; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const respond = async (id: string, accept: boolean) => {
    setBusy(true);
    try { await rpc('respond_roommate', { p_link_id: id, p_accept: accept }); await onChanged(); } finally { setBusy(false); }
  };
  return (
    <section className="card grid gap-2 ring-1 ring-accent/40">
      <h2 className="text-sm font-semibold">Roommate {list.length === 1 ? 'request' : 'requests'}</h2>
      {list.map((p) => (
        <div key={p.link_id} className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{titleCase(p.name) ?? '—'}</span>
            <span className="block text-xs text-muted">Coupon {p.coupon_number ?? '—'} wants to add you</span>
          </span>
          <button aria-label="Decline" disabled={busy} onClick={() => respond(p.link_id, false)} className="rounded-full p-2 text-muted hover:bg-subtle"><X size={18} /></button>
          <button aria-label="Accept" disabled={busy} onClick={() => respond(p.link_id, true)} className="rounded-full bg-accent p-2 text-accent-fg"><Check size={18} /></button>
        </div>
      ))}
    </section>
  );
}

function ChangePassword() {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState({ next: '', again: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div className="grid gap-1">
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => { setOpen(true); setMsg(null); }}>
            <span className="flex items-center justify-center gap-2 text-sm"><KeyRound size={16} /> Password</span>
          </Button>
          <Button onClick={async () => { await signOut(); location.href = withBase('/login'); }}>
            <span className="flex items-center justify-center gap-2 text-sm"><LogOut size={16} /> Sign out</span>
          </Button>
        </div>
        {msg && <p className="text-center text-sm text-muted" role="status">{msg}</p>}
      </div>
    );
  }
  return (
    <form className="card grid gap-3" onSubmit={async (e) => {
      e.preventDefault();
      if (pw.next !== pw.again) { setMsg('The two passwords are different.'); return; }
      setBusy(true);
      try {
        await authAction('change_password', { password: pw.next });
        setMsg('Password changed.');
        setPw({ next: '', again: '' });
        setOpen(false);
      } catch (err) {
        setMsg((err as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">Change password</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-muted">Cancel</button>
      </div>
      <label className="grid gap-1 text-sm"><span>New password (8+ characters)</span>
        <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required /></label>
      <label className="grid gap-1 text-sm"><span>New password again</span>
        <input className="input" type="password" autoComplete="new-password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} required /></label>
      <Button type="submit" variant="primary" disabled={busy} className="w-fit">Change password</Button>
      {msg && <p className="text-sm text-muted" role="status">{msg}</p>}
    </form>
  );
}

/**
 * Deleting the account only changes things from now on: past meals, attendance and the
 * coupon held until today stay on record as they were; the sign-in stops and the coupon is freed.
 */
function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await rpc<{ status: string }>('delete_my_account', { p_confirm: typed });
      if (r.status === 'LAST_SUPER_ADMIN') { setMsg('You are the only dev. Make someone else a dev first.'); return; }
      if (r.status !== 'DELETED') { setMsg('Type DELETE to confirm.'); return; }
      await accountRoute('close_login', {}).catch(() => undefined);
      await signOut().catch(() => undefined);
      location.href = withBase('/login');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button onClick={() => setOpen(true)} className="mx-auto flex items-center gap-1.5 py-2 text-sm text-muted hover:text-bad">
        <Trash2 size={14} /> Delete account
      </button>
      {open && (
        <Sheet title="Delete your account?" onClose={() => setOpen(false)}>
          <div className="grid gap-3 text-sm">
            <ul className="grid gap-1.5 rounded-xl bg-subtle p-3">
              <li>• You can’t sign in again with this account.</li>
              <li>• Your coupon is freed for its next holder.</li>
              <li>• Seats you booked and your roommate links are cancelled.</li>
              <li>• Your past meals and records stay with the hall as they were.</li>
            </ul>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type DELETE to confirm"
              aria-label="Type DELETE to confirm" autoCapitalize="characters" />
            {msg && <p className="text-bad" role="alert">{msg}</p>}
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setOpen(false)}>Keep my account</Button>
              <button disabled={busy || typed.trim().toUpperCase() !== 'DELETE'} onClick={remove}
                className="min-h-12 rounded-2xl bg-bad px-5 font-semibold text-accent-fg disabled:opacity-40">
                {busy ? 'Deleting…' : 'Delete account'}
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** Earlier names, student IDs and coupons, and who held this coupon before (hidden when there are none). */
function MyHistory() {
  const { data } = useLoad(() => rpc<PersonHistory & { coupon_number: number | null; earlier_holders: EarlierHolder[] }>('my_history'),
    undefined, { lazy: true, cache: 'my-history', fresh: 10 * 60000 });
  if (!data) return null;
  return <HistoryCard history={data} earlier={data.earlier_holders} couponNumber={data.coupon_number} you />;
}
