'use client';

import { ChevronDown, ChevronRight, Crown, EyeOff, History, Megaphone, MessageSquareReply, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ConfirmButton, Empty, Panel } from '@/components/admin-shell';
import { FeedbackForm } from '@/components/feedback-form';
import { Managers, MonthHero, MonthTiles, type Dashboard } from '@/components/mess-month';
import { NominationCard } from '@/components/nomination-card';
import { Button } from '@/components/sheet';
import { PageSkeleton, SkeletonList } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { dhakaDate, monthStage } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useSession, type Session } from '@/lib/session';
import { useLoad } from '@/lib/use-load';

/**
 * Mess: the running mess month (dates and progress), its meals by kind, the managers, other
 * months, and feedback to the managers with the answers they gave.
 */
export default function MessPage() {
  const session = useSession();
  const [monthId, setMonthId] = useState<string | null>(null);
  const { data, reload } = useLoad(session ? () => rpc<Dashboard>('mess_dashboard', { p_mess_month_id: monthId }) : null, undefined,
    { cache: 'mess-current', fresh: 5 * 60000 });
  useEffect(() => { if (monthId) reload(); }, [monthId, reload]);
  // Open on the running month, not a next month that has been set up but not started.
  const running = data?.months.find((x) => monthStage(x) === 'Current');
  useEffect(() => {
    if (!monthId && running && data?.month && data.month.id !== running.id) setMonthId(running.id);
  }, [monthId, running, data]);

  if (!session) return <PageSkeleton />;
  const m = data?.month;
  const others = data ? data.months.filter((x) => x.id !== m?.id).length : 0;

  return (
    <AppFrame session={session} active="mess" width="feed">
      <NominationCard onDone={reload} />
      {!data ? <SkeletonList count={3} /> : !m ? (
        <Panel title="No mess month yet">
          <Empty>The hall office starts mess month 1 by nominating the first mess managers.</Empty>
        </Panel>
      ) : null}
      {data && !m && (
        <Link href="/announcements" className="card flex items-center gap-3 transition hover:bg-subtle active:scale-[0.99]">
          <span className="flex size-10 items-center justify-center rounded-2xl bg-subtle"><Megaphone size={18} /></span>
          <span className="flex-1 font-semibold">Announcements</span>
          <ChevronRight size={18} className="text-muted" />
        </Link>
      )}
      {data && m && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <MonthHero month={m} onChanged={reload} />
            <MonthTiles month={m} />
          </div>
          <Managers managers={m.managers} />
          {others > 0 && (
            <Link href="/mess/months" className="card flex items-center gap-3 transition hover:bg-subtle active:scale-[0.99]">
              <span className="flex size-10 items-center justify-center rounded-2xl bg-subtle"><History size={18} /></span>
              <span className="flex-1">
                <span className="block font-semibold">Other mess months</span>
                <span className="block text-xs text-muted">{others} {others === 1 ? 'month' : 'months'}</span>
              </span>
              <ChevronRight size={18} className="text-muted" />
            </Link>
          )}
          {data.is_admin && m.is_latest && <Handover session={session} data={data} onChanged={reload} />}
        </>
      )}
      {data && !m && session.role === 'SUPER_ADMIN' && data.is_admin && <Handover session={session} data={data} onChanged={reload} />}


      {/* Feedback goes to the mess managers, so they and devs don't get the form (back once they resign). */}
      {session.coupon_number !== null && session.role !== 'ADMIN' && session.role !== 'SUPER_ADMIN' && <FeedbackForm mealId={null} title="Anonymous" />}
      <Replies />
    </AppFrame>
  );
}

type Reply = { id: string; kind: string; body: string; reply: string; created_on: string; replied_at: string };
const KIND_TONE: Record<string, string> = { COMPLAINT: 'bg-bad-soft text-bad', SUGGESTION: 'bg-accent-soft text-accent', FEEDBACK: 'bg-ok-soft text-ok' };

/** Feedback the managers answered: the message and the answer, never who sent it. */
function Replies() {
  const { data } = useLoad(() => rpc<Reply[]>('feedback_replies', { p_limit: 20 }), undefined, { lazy: true, cache: 'feedback-replies', fresh: 5 * 60000 });
  const [all, setAll] = useState(false);
  if (!data || data.length === 0) return null;
  const shown = all ? data : data.slice(0, 3);
  return (
    <section className="grid gap-2">
      <h2 className="flex items-center gap-2 px-1 text-sm font-semibold text-muted"><MessageSquareReply size={16} /> Answered by the mess managers</h2>
      {shown.map((r) => (
        <article key={r.id} className="card grid gap-2">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className={`rounded-full px-2 py-0.5 font-medium capitalize ${KIND_TONE[r.kind] ?? 'bg-subtle'}`}>{r.kind.toLowerCase()}</span>
            <span className="flex items-center gap-1"><EyeOff size={11} /> Anonymous</span>
            <span className="ml-auto shrink-0">{dhakaDate(r.created_on)}</span>
          </div>
          <p className="whitespace-pre-line text-sm">{r.body}</p>
          <p className="whitespace-pre-line rounded-xl border-l-4 border-accent bg-accent-soft/60 px-3 py-2 text-sm">
            <span className="mb-0.5 block text-xs font-semibold text-accent">Mess managers</span>{r.reply}
          </p>
        </article>
      ))}
      {data.length > 3 && !all && (
        <button onClick={() => setAll(true)} className="mx-auto flex items-center gap-1 py-1 text-sm font-medium text-accent">
          Show all {data.length} <ChevronDown size={15} />
        </button>
      )}
    </section>
  );
}

function Handover({ session, data, onChanged }: { session: Session; data: Dashboard; onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<{ id: string; name: string; coupon_number: number | null; role: string }>>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const canNominate = session.role === 'SUPER_ADMIN' || data.i_am_active_manager;
  const [open, setOpen] = useState(false);
  // Add a fellow manager to this month, or hand over to a new month the nominee sets up.
  const [next, setNext] = useState(false);

  const search = async () => {
    setResults(await rpc('admin_find_people', { p_query: q.trim() }));
  };
  const act = async (fn: () => Promise<{ status: string; message?: string }>, ok: Record<string, string>) => {
    try {
      const r = await fn();
      setMsg(ok[r.status] ?? r.message ?? r.status.replaceAll('_', ' ').toLowerCase());
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="flex items-center gap-3 rounded-2xl border-2 border-bad/50 bg-bad-soft p-4 text-left text-bad shadow-sm transition hover:border-bad">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-bad text-accent-fg"><Crown size={22} /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-lg font-semibold">Hand over</span>
          <span className="block text-sm opacity-80">Add a fellow manager, or hand over to a new mess month{session.role === 'ADMIN' ? ', or resign' : ''}.</span>
        </span>
        <ChevronDown size={18} />
      </button>
    );
  }

  return (
    <Panel title={<span className="flex items-center gap-2"><Crown size={16} /> Hand over</span>}
      action={<button onClick={() => setOpen(false)} className="text-sm text-muted">Close</button>}>
      {canNominate && (
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-2xl bg-subtle p-1 text-sm font-medium" role="radiogroup" aria-label="Nominate for">
          {[{ v: false, label: 'Add to this month' }, { v: true, label: 'New mess month' }].map((o) => (
            <button key={o.label} type="button" role="radio" aria-checked={next === o.v} onClick={() => setNext(o.v)}
              className={`rounded-xl px-3 py-2 transition ${next === o.v ? 'bg-surface shadow-sm' : 'text-muted'}`}>{o.label}</button>
          ))}
        </div>
      )}
      <p className="mb-3 text-sm text-muted">
        {next
          ? 'The nominee accepts and sets up the next mess month: its name, dates and banner. The first to accept creates it; later nominees join it. Then resign to hand over.'
          : `The nominee accepts and joins mess month ${data.month?.serial ?? ''}${data.month ? ` (${data.month.name})` : ''} as a fellow manager.`}
      </p>
      {msg && <p className="mb-3 rounded-xl bg-subtle px-3 py-2 text-sm" role="status">{msg}</p>}

      {canNominate && (
        <>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <input className="input min-w-0 flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Coupon number or name"
              aria-label="Find a student to nominate" />
            <Button type="submit"><span className="flex items-center gap-1"><Search size={16} /> Find</span></Button>
          </form>
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-border text-sm">
              {results.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                  <span>{p.name} {p.coupon_number && <span className="text-muted">· coupon {p.coupon_number}</span>}</span>
                  <Button disabled={!p.coupon_number} onClick={() => act(() => rpc('nominate_manager', { p_user_id: p.id, p_note: null, p_next_month: next }), {
                    NOMINATED: next ? `${p.name} has been asked to take over the next mess month; they accept from their account.`
                      : `${p.name} has been asked to join this month; they accept from their account.`,
                    ALREADY_NOMINATED: `${p.name} already has a pending nomination.`,
                    ALREADY_MANAGER: `${p.name} is already a mess manager.`,
                    NOT_A_VERIFIED_STUDENT: 'Only students with a verified coupon can be managers.',
                  })}>Nominate</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {data.nominations && data.nominations.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1 text-sm font-medium">Recent nominations</h3>
          <ul className="divide-y divide-border text-sm">
            {data.nominations.map((n) => (
              <li key={n.id} className="flex items-center justify-between gap-2 py-2">
                <span>{n.nominee} <span className="text-muted">· {n.next_month ? 'new month' : 'this month'} · by {n.nominated_by} · {n.status.toLowerCase()}</span></span>
                {n.status === 'PENDING' && (
                  <Button onClick={() => act(() => rpc('cancel_nomination', { p_nomination_id: n.id }), { CANCELLED: 'Nomination withdrawn.' })}>
                    Withdraw
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {session.role === 'ADMIN' && (
        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-sm text-muted">Resign as mess manager? You go back to being a student; your record stays.</span>
          <ConfirmButton variant="danger" onConfirm={() => act(() => rpc('retire_manager', { p_user_id: null }), {
            RETIRED: 'You have resigned. Thank you for serving!', NOT_ACTIVE: 'You are not an active manager.',
          })}>Resign</ConfirmButton>
        </div>
      )}
    </Panel>
  );
}

