'use client';

import { Check, Eye, EyeOff, Lightbulb, MessageSquareReply, MessageSquareText, Send, ThumbsDown, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { AdminShell, Notice } from '@/components/admin-shell';
import { mealLabel } from '@/components/meal-card';
import { Button } from '@/components/sheet';
import { SkeletonList } from '@/components/skeleton';
import { dhakaDate } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Feedback = {
  id: string; kind: 'COMPLAINT' | 'SUGGESTION' | 'FEEDBACK'; body: string; created_on: string; status: 'NEW' | 'SEEN' | 'RESOLVED';
  admin_note: string | null; reply_public: boolean; handled_by: string | null;
  event: { name: string | null; meal_type: string; occasion: string } | null;
};

const KINDS: Array<{ key: Feedback['kind'] | 'ALL'; label: string; icon: LucideIcon; tone: string }> = [
  { key: 'ALL', label: 'All', icon: MessageSquareText, tone: 'bg-subtle text-fg' },
  { key: 'COMPLAINT', label: 'Complaints', icon: ThumbsDown, tone: 'bg-bad-soft text-bad' },
  { key: 'SUGGESTION', label: 'Suggestions', icon: Lightbulb, tone: 'bg-accent-soft text-accent' },
  { key: 'FEEDBACK', label: 'Feedback', icon: MessageSquareText, tone: 'bg-ok-soft text-ok' },
];

export default function FeedbackPage() {
  return <AdminShell active="review">{() => <Inbox />}</AdminShell>;
}

/**
 * Everything students sent the managers (anonymous): sorted by kind, newest and unanswered first.
 * A reply shows to everyone on the Mess tab with the message, never with who sent it.
 */
function Inbox() {
  const { data, error, reload } = useLoad(() => rpc<Feedback[]>('list_feedback', { p_mess_month_id: null, p_include_resolved: true }), 60000,
    { cache: 'admin-feedback' });
  const [kind, setKind] = useState<(typeof KINDS)[number]['key']>('ALL');
  const [done, setDone] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const list = (data ?? []).filter((f) => (kind === 'ALL' || f.kind === kind) && (done ? f.status === 'RESOLVED' : f.status !== 'RESOLVED'));
  const count = (k: string) => (data ?? []).filter((f) => (k === 'ALL' || f.kind === k) && f.status !== 'RESOLVED').length;

  return (
    <>
      <p className="-mt-2 flex items-center gap-1.5 text-sm text-muted"><EyeOff size={14} /> Anonymous: nobody, not even a dev, can see who sent them.</p>
      <nav className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4" aria-label="Kinds">
        {KINDS.map((k) => (
          <button key={k.key} onClick={() => setKind(k.key)} aria-pressed={kind === k.key}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition ${kind === k.key ? 'border-fg bg-fg text-bg' : 'border-border'}`}>
            <k.icon size={15} /> {k.label}
            {count(k.key) > 0 && <span className={`rounded-full px-1.5 text-xs font-semibold tabular-nums ${kind === k.key ? 'bg-bg/20' : 'bg-subtle'}`}>{count(k.key)}</span>}
          </button>
        ))}
      </nav>
      <div className="inline-flex w-fit rounded-full bg-subtle p-1 text-sm" role="tablist">
        {[false, true].map((d) => (
          <button key={String(d)} role="tab" aria-selected={done === d} onClick={() => setDone(d)}
            className={`rounded-full px-4 py-1.5 ${done === d ? 'bg-surface font-medium shadow-sm' : 'text-muted'}`}>{d ? 'Done' : 'To answer'}</button>
        ))}
      </div>
      <Notice text={note} />
      {!data ? (error ? <p className="text-sm text-bad">{error}</p> : <SkeletonList count={3} />) : list.length === 0 ? (
        <p className="rounded-2xl bg-subtle px-4 py-8 text-center text-sm text-muted">{done ? 'Nothing answered yet.' : 'All caught up.'}</p>
      ) : (
        <ul className="grid gap-3">
          {list.map((f) => <Item key={f.id} f={f} onChanged={reload} onNote={setNote} />)}
        </ul>
      )}
    </>
  );
}

function Item({ f, onChanged, onNote }: { f: Feedback; onChanged: () => Promise<void>; onNote: (t: string) => void }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const k = KINDS.find((x) => x.key === f.kind)!;
  const run = async (fn: () => Promise<{ status: string }>, ok: string) => {
    setBusy(true);
    try {
      const r = await fn();
      onNote(r.status === 'OK' ? ok : r.status === 'INVALID_REPLY' ? 'Write a reply first (up to 1000 characters).' : r.status);
      if (r.status === 'OK') setReply('');
      await onChanged();
    } catch (e) {
      onNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`card grid gap-3 ${f.status === 'NEW' ? 'ring-1 ring-accent/40' : ''}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${k.tone}`}><k.icon size={12} /> {k.label.replace(/s$/, '')}</span>
        <span>{f.event ? mealLabel(f.event) : 'General'} · {dhakaDate(f.created_on)}</span>
        {f.status === 'NEW' && <span className="rounded-full bg-accent px-2 py-0.5 font-semibold text-accent-fg">New</span>}
      </div>
      <p className="whitespace-pre-line">{f.body}</p>
      {f.admin_note && (
        <p className={`whitespace-pre-line rounded-xl border-l-4 px-3 py-2 text-sm ${f.reply_public ? 'border-accent bg-accent-soft/60' : 'border-border bg-subtle'}`}>
          <span className="mb-0.5 block text-xs font-semibold text-muted">
            {f.reply_public ? 'Reply, shown to everyone' : 'Private note'}{f.handled_by && ` · ${f.handled_by}`}
          </span>
          {f.admin_note}
        </p>
      )}
      {f.status !== 'RESOLVED' && (
        <div className="grid gap-2">
          <textarea className="input" rows={2} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)}
            placeholder="Write a reply…" aria-label="Reply" />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy || !reply.trim()}
              onClick={() => run(() => rpc('reply_feedback', { p_feedback_id: f.id, p_reply: reply }), 'Replied. Everyone sees it on the Mess tab.')}>
              <span className="flex items-center gap-2"><Send size={16} /> Reply</span>
            </Button>
            {f.status === 'NEW' && (
              <Button disabled={busy} onClick={() => run(() => rpc('update_feedback', { p_feedback_id: f.id, p_status: 'SEEN', p_note: null }), 'Marked as seen.')}>
                <span className="flex items-center gap-2"><Eye size={16} /> Seen</span>
              </Button>
            )}
            <Button disabled={busy} onClick={() => run(() => rpc('update_feedback', { p_feedback_id: f.id, p_status: 'RESOLVED', p_note: null }), 'Marked as done.')}>
              <span className="flex items-center gap-2"><Check size={16} /> Done, no reply</span>
            </Button>
          </div>
          <p className="flex items-center gap-1 text-xs text-muted"><MessageSquareReply size={12} /> A reply shows on everyone’s Mess tab with this message, never with who sent it.</p>
        </div>
      )}
    </li>
  );
}
