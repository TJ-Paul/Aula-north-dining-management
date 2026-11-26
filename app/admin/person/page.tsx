'use client';

import { ArrowLeft, BadgeCheck, BedDouble, CalendarDays, Check, Phone, Send, Utensils } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AdminShell, Empty } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { HistoryCard, type EarlierHolder, type PersonHistory } from '@/components/history';
import { Avatar, MealDaysTable, PersonLine, type MealDay, type PersonCard } from '@/components/person';
import { dhakaDate, titleCase } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';
import { ROLE_LABEL, isDev, type Role, type Session } from '@/lib/session';
import { DevTools } from '@/components/dev-tools';
import { MissedMark } from '@/components/missed-mark';

type Person = {
  user_id: string; name: string | null; avatar_url: string | null; student_id: string | null; room: string | null; phone: string | null;
  role: string; joined_at: string; coupon_number: number | null; meals_eaten: number; last_meal_at: string | null; missed: number;
  missed_recent?: number; missed_marked?: boolean;
  not_coming_kept: number; came_anyway: number; points: number; walk_ins: number; has_plate: boolean;
  register: { name?: string; student_id?: string } | null;
  roommates: { accepted: PersonCard[]; incoming: PersonCard[]; outgoing: PersonCard[] };
  days: MealDay[];
  history: PersonHistory; earlier_holders: EarlierHolder[];
  managed?: Array<{ id: string; serial: number; name: string; status: 'ACTIVE' | 'RETIRED' }>;
  mess_months?: Array<{ id: string; serial: number; name: string; starts_on: string; ends_on: string }> | null;
};

/** The page's id is in the address (?id=…), so one static page serves them all. */
export default function Page() {
  return <Suspense><PersonPage /></Suspense>;
}

function PersonPage() {
  const q = useSearchParams();
  const id = q.get('id') ?? '';
  return <AdminShell active="everyone" plain>{(s) => <PersonView key={id} id={id} me={s} />}</AdminShell>;
}

/** Everything about one student: identity, meal counts, roommates (each a link to their own page) and meal days. */
function PersonView({ id, me }: { id: string; me: Session }) {
  const { data, error, reload } = useLoad(() => rpc<Person>('admin_person', { p_user_id: id }));
  if (!data) return <Empty>{error ?? 'Loading…'}</Empty>;
  const p = data;
  const stats: Array<[string, number, string?]> = [
    ['Dined', p.meals_eaten], ['Missed', p.missed, p.missed ? 'text-bad' : undefined],
    ['Joined without booking', p.walk_ins, p.walk_ins ? 'text-warn' : undefined],
  ];

  return (
    <>
      <Link href="/admin/everyone" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Database</Link>

      <section className="card flex flex-wrap items-center gap-4">
        <Avatar url={p.avatar_url} size="xl" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            {titleCase(p.name) ?? '—'}
            {p.coupon_number && <BadgeCheck size={20} className="text-ok" aria-label="Verified" />}
            {p.missed_marked && <MissedMark count={p.missed_recent} />}
          </h1>
          <p className="text-muted">
            Coupon <b className="text-fg tabular-nums">{p.coupon_number ?? '—'}</b> · {p.student_id ?? 'no student ID'}
            {p.room && <> · room <b className="text-fg">{p.room}</b></>}
          </p>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            {p.phone && <span className="flex items-center gap-1"><Phone size={14} /> {p.phone}</span>}
            {p.role !== 'STUDENT' && <span className="font-medium text-accent">{ROLE_LABEL[p.role as Role] ?? p.role}</span>}
            <span>Joined {dhakaDate(p.joined_at)}</span>
            {p.last_meal_at && <span>Last ate {dhakaDate(p.last_meal_at)}</span>}
          </p>
          {p.register?.name && p.name && p.register.name.toLowerCase() !== p.name.toLowerCase() && (
            <p className="text-xs text-muted">Hall register name: {p.register.name}</p>
          )}
        </div>
      </section>

      <div className="grid grid-cols-3 gap-3">
        {stats.map(([label, n, tone]) => (
          <div key={label} className="card py-3">
            <p className={`text-2xl font-semibold tabular-nums ${tone ?? ''}`}>{n}</p>
            <p className="text-xs text-muted">{label}</p>
          </div>
        ))}
      </div>

      {isDev(me) && !me.view_only && <DevTools person={p} me={me} onChanged={reload} />}

      {p.coupon_number && (
        <div className="flex flex-wrap items-start gap-3">
          <PlateToggle coupon={p.coupon_number} initial={p.has_plate} />
          <SendMessage coupon={p.coupon_number} />
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><BedDouble size={18} className="text-accent" /> Roommates</h2>
          {p.roommates.accepted.length === 0 && <p className="text-sm text-muted">None added.</p>}
          {p.roommates.accepted.map((r) => <PersonLine key={r.user_id} p={r} href={`/admin/person/?id=${r.user_id}`} />)}
          {p.roommates.outgoing.length + p.roommates.incoming.length > 0 && (
            <>
              <p className="mt-2 text-xs text-muted">Waiting to accept</p>
              {[...p.roommates.outgoing, ...p.roommates.incoming].map((r) => <PersonLine key={r.user_id} p={r} href={`/admin/person/?id=${r.user_id}`} />)}
            </>
          )}
        </section>
        <div className="grid gap-4">
        <HistoryCard history={p.history} earlier={p.earlier_holders} couponNumber={p.coupon_number} you={false} />
        <section className="card">
          <h2 className="mb-1 flex items-center gap-2 font-semibold"><CalendarDays size={18} className="text-accent" /> Last 30 days</h2>
          <MealDaysTable days={p.days} />
        </section>
        </div>
      </div>
    </>
  );
}

/** A one-way message to this coupon holder; it arrives in their notifications and they can't reply. */
function SendMessage({ coupon }: { coupon: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => { setOpen(true); setNote(null); }}>
          <span className="flex items-center gap-2"><Send size={16} /> Send message</span>
        </Button>
        {note && <span className="text-sm text-muted" role="status">{note}</span>}
      </div>
    );
  }
  return (
    <form className="card grid gap-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      try {
        const r = await rpc<{ status: string }>('admin_send_message', { p_coupon_number: coupon, p_message: text });
        if (r.status === 'SENT') { setText(''); setOpen(false); setNote(`Sent to coupon ${coupon}.`); }
        else setNote(r.status === 'NO_HOLDER' ? 'Nobody holds this coupon now.' : 'Write a message first.');
      } catch (err) {
        setNote((err as Error).message);
      } finally {
        setBusy(false);
      }
    }}>
      <textarea className="input" rows={3} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} autoFocus
        placeholder={`Message to coupon ${coupon}`} aria-label={`Message to coupon ${coupon}`} required />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted">Shows in their notifications. They can’t reply.</span>
        <span className="flex gap-2">
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>Send</Button>
        </span>
      </div>
      {note && <p className="text-sm text-muted">{note}</p>}
    </form>
  );
}

/** Ticked while this student has a plate from the dining hall. */
function PlateToggle({ coupon, initial }: { coupon: number; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <button disabled={busy} aria-pressed={on} onClick={async () => {
      setBusy(true);
      try {
        const r = await rpc<{ status: string }>('set_plate', { p_coupon_number: coupon, p_has_plate: !on });
        if (r.status === 'OK') setOn(!on);
      } finally {
        setBusy(false);
      }
    }}
      className={`flex min-h-12 items-center gap-2 rounded-xl px-4 font-medium transition ${on ? 'bg-warn-soft text-warn' : 'bg-subtle text-muted hover:text-fg'}`}>
      <span className={`flex size-5 items-center justify-center rounded-md border-2 ${on ? 'border-warn bg-warn text-bg' : 'border-border'}`}>
        {on && <Check size={13} />}
      </span>
      <Utensils size={16} /> Has a plate
    </button>
  );
}
