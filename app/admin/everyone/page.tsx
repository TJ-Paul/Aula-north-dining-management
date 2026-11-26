'use client';

import { BadgeCheck, BellRing, Check, Download, GraduationCap, Search, ShieldCheck, UserRound, Utensils } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { StaffAndRoles } from '@/components/staff-roles';
import type { Session } from '@/lib/session';
import { AdminShell, Empty, Panel } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { dhakaDate, titleCase } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';
import { MissedMark } from '@/components/missed-mark';

type Row = {
  coupon_number: number | null; coupon_status: string | null; register_name: string | null; register_student_id: string | null;
  account: 'HOLDER' | 'PENDING' | 'UNCLAIMED' | 'NO_COUPON';
  user_id: string | null; public_id?: string; name?: string; avatar_url?: string | null; student_id?: string | null; room?: string | null; phone?: string | null;
  role?: string; joined_at?: string; meals_eaten?: number; last_meal_at?: string | null; missed?: number;
  missed_recent?: number; missed_marked?: boolean;
  not_coming_kept?: number; came_anyway?: number; points?: number; coupon_meals?: number | null; has_plate?: boolean; plate_marked_at?: string | null;
};

const FILTERS = [{ key: 'all', label: 'All students' }, { key: 'plates', label: 'Has a plate' }] as const;

export default function EveryonePage() {
  return <AdminShell active="everyone">{(s) => <Sections session={s} />}</AdminShell>;
}

/** Students (everyone in the register) and staff (accounts and roles), as two sections. */
function Sections({ session }: { session: Session }) {
  const [section, setSection] = useState<'students' | 'staff'>('students');
  useEffect(() => {
    if (new URLSearchParams(location.search).get('section') === 'staff') setSection('staff');
  }, []);
  const pick = (s: 'students' | 'staff') => {
    setSection(s);
    history.replaceState(null, '', s === 'staff' ? '?section=staff' : location.pathname);
  };
  return (
    <>
      <div className="inline-flex w-fit rounded-full bg-subtle p-1 text-sm" role="tablist">
        {([['students', 'Students', GraduationCap], ['staff', 'Staff & roles', ShieldCheck]] as const).map(([k, label, Icon]) => (
          <button key={k} role="tab" aria-selected={section === k} onClick={() => pick(k)}
            className={`flex items-center gap-2 rounded-full px-4 py-1.5 ${section === k ? 'bg-surface font-medium shadow-sm' : 'text-muted'}`}>
            <Icon size={16} aria-hidden /> {label}
          </button>
        ))}
      </div>
      {section === 'students' ? <Everyone /> : <StaffAndRoles session={session} />}
    </>
  );
}

function Everyone() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all');
  const { data, error, reload } = useLoad(() => rpc<Row[]>('admin_people_data', { p_query: query || null }));
  useEffect(() => { reload(); }, [query, reload]);

  if (!data) return <Empty>{error ?? 'Loading…'}</Empty>;
  const rows = filter === 'plates' ? data.filter((r) => r.has_plate) : data;
  const count = (k: string) => (k === 'all' ? data.length : data.filter((r) => r.has_plate).length);
  const returned = async (coupon: number) => { await rpc('set_plate', { p_coupon_number: coupon, p_has_plate: false }); await reload(); };

  return (
    <>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(input.trim()); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Coupon, student ID, name or room"
          aria-label="Search everyone" className="input min-w-0 flex-1" />
        <Button type="submit" variant="primary"><span className="flex items-center gap-2"><Search size={16} aria-hidden /> Search</span></Button>
      </form>

      <nav className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 text-sm" aria-label="Filter">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`shrink-0 rounded-full border px-3 py-1 ${filter === f.key ? 'border-fg bg-fg text-bg' : 'border-border'}`}>
            {f.key === 'plates' && <Utensils size={13} className="mr-1 inline align-[-2px]" aria-hidden />}{f.label} · {count(f.key)}
          </button>
        ))}
      </nav>

      {filter === 'plates' && <PlatesBar out={count('plates')} onChanged={reload} />}

      <Panel title={`${rows.length} ${rows.length === 1 ? 'person' : 'people'}${query ? ` matching “${query}”` : ''}`}
        action={<Button onClick={() => downloadCsv(rows)}><span className="flex items-center gap-2"><Download size={16} aria-hidden /> Download CSV</span></Button>}>
        {rows.length === 0 ? <Empty>Nobody here.</Empty> : (<>
          <ul className="-mx-1 divide-y divide-border md:hidden">
            {rows.map((r, i) => {
              const body = (<>
                <Avatar url={r.avatar_url ?? null} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium"><span className="tabular-nums">{r.coupon_number ?? '—'}</span> · {titleCase(r.name ?? r.register_name) ?? '—'}
                    {r.missed_marked && <> <MissedMark count={r.missed_recent} /></>}</p>
                  <p className="truncate text-xs text-muted">
                    {r.student_id ?? r.register_student_id ?? 'no ID'}{r.room && ` · room ${r.room}`}
                    {r.user_id && ` · ate ${r.meals_eaten ?? 0}`}
                  </p>
                </div>
                {r.has_plate && <PlateMark />}
                {(r.user_id || r.coupon_number) && (
                  <span title="Meals eaten" aria-label={`Ate ${r.user_id ? r.meals_eaten : r.coupon_meals ?? 0}`}
                    className="shrink-0 rounded-md bg-black px-2 py-0.5 text-sm font-bold tabular-nums text-white">{r.user_id ? r.meals_eaten : r.coupon_meals ?? 0}</span>
                )}
                {r.account === 'HOLDER' ? <BadgeCheck size={18} className="shrink-0 text-ok" aria-label="Verified" /> : <span className="text-muted">—</span>}
              </>);
              return (
                <li key={`${r.coupon_number ?? 'x'}-${r.user_id ?? i}`} className="flex items-center">
                  <div className="min-w-0 flex-1">{r.user_id
                    ? <Link href={`/admin/person/?id=${r.user_id}`} className="flex items-center gap-3 px-1 py-2.5 hover:bg-subtle">{body}</Link>
                    : r.coupon_number ? <Link href={`/admin/coupon/?n=${r.coupon_number}`} className="flex items-center gap-3 px-1 py-2.5 hover:bg-subtle">{body}</Link>
                    : <div className="flex items-center gap-3 px-1 py-2.5">{body}</div>}</div>
                  {filter === 'plates' && r.coupon_number && <ReturnedButton onClick={() => returned(r.coupon_number!)} />}
                </li>
              );
            })}
          </ul>
          <div className="-mx-4 hidden overflow-x-auto px-4 md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-2 pr-3 font-normal">Coupon</th><th className="pr-3 font-normal">Name</th>
                  <th className="pr-3 font-normal">Student ID</th><th className="pr-3 text-center font-normal">Verified</th>
                  <th className="pr-3 font-normal">Room</th><th className="text-right font-normal">Ate</th>
                  {filter === 'plates' && <th />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r, i) => (
                  <tr key={`${r.coupon_number ?? 'x'}-${r.user_id ?? i}`}
                    onClick={r.user_id ? () => router.push(`/admin/person/?id=${r.user_id}`)
                      : r.coupon_number ? () => router.push(`/admin/coupon/?n=${r.coupon_number}`) : undefined}
                    className={`align-middle ${r.user_id || r.coupon_number ? 'cursor-pointer hover:bg-subtle' : ''}`}>
                    <td className="py-2 pr-3 font-semibold tabular-nums">{r.coupon_number ?? '—'}</td>
                    <td className="pr-3">
                      <div className="flex items-center gap-2">
                        <Avatar url={r.avatar_url ?? null} />
                        {r.user_id
                          ? <Link href={`/admin/person/?id=${r.user_id}`} className="hover:underline">{titleCase(r.name ?? r.register_name ?? null) ?? '—'}</Link>
                          : <span>{titleCase(r.register_name ?? null) ?? '—'}</span>}
                        {r.has_plate && <PlateMark />}
                        {r.missed_marked && <MissedMark count={r.missed_recent} />}
                      </div>
                    </td>
                    <td className="pr-3 tabular-nums">{r.student_id ?? r.register_student_id ?? '—'}</td>
                    <td className="pr-3 text-center">
                      {r.account === 'HOLDER' ? <BadgeCheck size={18} className="inline text-ok" aria-label="Verified" /> : <span className="text-muted">—</span>}
                    </td>
                    <td className="pr-3">{r.room ?? '—'}</td>
                    <td className="text-right tabular-nums">{r.user_id ? r.meals_eaten : r.coupon_meals ?? '—'}</td>
                    {filter === 'plates' && (
                      <td className="pl-3 text-right" onClick={(e) => e.stopPropagation()}>
                        {r.coupon_number && <ReturnedButton onClick={() => returned(r.coupon_number!)} />}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>)}
      </Panel>
    </>
  );
}

function PlateMark() {
  return (
    <span title="Has a plate from the dining hall" className="flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-medium text-warn">
      <Utensils size={12} aria-hidden /> plate
    </span>
  );
}

function ReturnedButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex shrink-0 items-center gap-1 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg">
      <Check size={14} /> Returned
    </button>
  );
}

/** Mark a coupon holder who took a plate, and remind everyone who still has one. */
function PlatesBar({ out, onChanged }: { out: number; onChanged: () => void }) {
  const [coupon, setCoupon] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { setNote((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="card grid gap-3">
      <form className="flex gap-2" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await rpc<{ status: string; person?: { name: string } }>('set_plate', { p_coupon_number: Number(coupon), p_has_plate: true });
          setNote(r.status === 'OK' ? `${coupon} · ${titleCase(r.person?.name ?? null) ?? ''} has a plate.` : `Nobody holds coupon ${coupon}.`);
          if (r.status === 'OK') { setCoupon(''); onChanged(); }
        });
      }}>
        <input value={coupon} onChange={(e) => setCoupon(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric"
          placeholder="Coupon number" aria-label="Coupon number of who took a plate" className="input min-w-0 flex-1" required />
        <Button type="submit" variant="primary" disabled={busy || !coupon}>
          <span className="flex items-center gap-2"><Utensils size={16} /> Took a plate</span>
        </Button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{out === 0 ? 'Every plate is back.' : `${out} ${out === 1 ? 'plate is' : 'plates are'} out.`}</p>
        {out > 0 && (
          <Button disabled={busy} onClick={() => run(async () => {
            const r = await rpc<{ count: number }>('remind_plates');
            setNote(`Reminder sent to ${r.count} ${r.count === 1 ? 'person' : 'people'}.`);
          })}>
            <span className="flex items-center gap-2"><BellRing size={16} /> Remind all to return</span>
          </Button>
        )}
      </div>
      {note && <p className="text-sm" role="status">{note}</p>}
    </section>
  );
}

/** The person's profile photo, or the plain person outline when they have none. */
function Avatar({ url }: { url: string | null }) {
  return url
    ? <img src={url} alt="" className="size-8 shrink-0 rounded-full object-cover" />
    : <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-subtle text-muted"><UserRound size={16} aria-hidden /></span>;
}

function downloadCsv(rows: Row[]) {
  const head = ['coupon', 'name', 'student_id', 'register_name', 'register_student_id', 'account', 'role', 'room', 'phone',
    'meals_eaten', 'missed', 'last_meal', 'joined', 'account_id'];
  const cell = (v: unknown) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lines = rows.map((r) => [r.coupon_number, r.name, r.student_id, r.register_name, r.register_student_id, r.account, r.role,
    r.room, r.phone, r.meals_eaten, r.missed,
    r.last_meal_at ? dhakaDate(r.last_meal_at) : '', r.joined_at ? dhakaDate(r.joined_at) : '', r.public_id].map(cell).join(','));
  const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aula-everyone-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
