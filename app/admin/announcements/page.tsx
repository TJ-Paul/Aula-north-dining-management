'use client';

import { Megaphone, Send } from 'lucide-react';
import { useState } from 'react';
import { AdminShell, Empty, Notice } from '@/components/admin-shell';
import { Button } from '@/components/sheet';
import { dhakaDate, dhakaTime } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Announcement = { id: string; body: string; created_at: string; by: string | null };

export default function AnnouncementsPage() {
  return <AdminShell active="announcements">{() => <Announcements />}</AdminShell>;
}

/** One message to everyone: it arrives as a notification (with sound) and stays in their bell. */
function Announcements() {
  const { data, reload } = useLoad(() => rpc<Announcement[]>('list_announcements', { p_limit: 30 }));
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ status: string; sent_to?: number }>('post_announcement', { p_body: text });
      setNote(r.status === 'SENT' ? `Sent to ${r.sent_to} people.` : 'Write a message first.');
      if (r.status === 'SENT') { setText(''); await reload(); }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Notice text={note} />
      <form className="card grid gap-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea className="input" rows={4} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Announcement to everyone" aria-label="Announcement to everyone" />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">Everyone gets it as a notification and in their bell.</span>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            <span className="flex items-center gap-2"><Send size={16} /> Send to all</span>
          </Button>
        </div>
      </form>
      {!data ? <Empty>Loading…</Empty> : data.length === 0 ? <Empty>No announcements yet.</Empty> : (
        <ul className="grid gap-2">
          {data.map((a) => (
            <li key={a.id} className="card flex gap-3">
              <Megaphone size={18} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="whitespace-pre-line">{a.body}</p>
                <p className="mt-1 text-xs text-muted">{dhakaDate(a.created_at)} · {dhakaTime(a.created_at)}{a.by && ` · ${a.by}`}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
