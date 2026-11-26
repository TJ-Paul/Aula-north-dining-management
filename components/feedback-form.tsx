'use client';

import { MessageSquareWarning } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/sheet';
import { rpc } from '@/lib/rpc';

/** Anonymous feedback to the admins, about one event (mealId) or in general (null). */
export function FeedbackForm({ mealId, title }: { mealId: string | null; title: string }) {
  const [kind, setKind] = useState('FEEDBACK');
  const [body, setBody] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="card">
      <h2 className="mb-3 flex items-center gap-2 font-semibold"><MessageSquareWarning size={18} className="text-accent" /> {title}</h2>
      <form className="grid gap-2" onSubmit={async (ev) => {
        ev.preventDefault();
        setBusy(true);
        try {
          const r = await rpc<{ status: string }>('submit_feedback', { p_kind: kind, p_body: body, p_meal_service_id: mealId });
          setMsg(r.status === 'SENT' ? 'Sent. Thank you!' : r.status === 'DAILY_LIMIT' ? 'You can send up to 10 a day.'
            : r.status === 'NOT_VERIFIED' ? 'Only students with a verified coupon can send feedback.' : r.status);
          if (r.status === 'SENT') setBody('');
        } catch (err) {
          setMsg((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}>
        <div className="flex gap-2" role="radiogroup" aria-label="Kind">
          {[['FEEDBACK', 'Feedback'], ['COMPLAINT', 'Complaint'], ['SUGGESTION', 'Suggestion']].map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={kind === v} onClick={() => setKind(v)}
              className={`rounded-full border px-3 py-1 text-sm ${kind === v ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-border text-muted'}`}>{l}</button>
          ))}
        </div>
        <textarea className="input" rows={3} value={body} onChange={(ev) => setBody(ev.target.value)} maxLength={2000}
          placeholder="Write here…" aria-label="Your message" required />
        <Button type="submit" variant="primary" className="w-fit" disabled={busy || body.trim().length < 3}>Send</Button>
      </form>
      {msg && <p className="mt-2 text-sm text-muted" role="status">{msg}</p>}
    </section>
  );
}

