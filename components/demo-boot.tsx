'use client';

import { LoaderCircle, RotateCcw, Ticket, ClipboardCheck, Utensils } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { BASE, withBase } from '@/lib/base';
import { currentUser, demoAccounts, onProgress, ready, resetDemo } from '@/lib/demo/engine';
import { demoSignIn } from '@/lib/session';

/** Waits until this page is controlled by the demo's service worker (it serves photos and posters). */
async function serviceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` });
    if (navigator.serviceWorker.controller) return;
    await new Promise<void>((done) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => done(), { once: true });
      setTimeout(done, 3000);
    });
  } catch { /* pictures just won't show */ }
}

/**
 * Starts the in-browser backend before any screen asks it for data, with a short loading screen
 * (the first visit downloads the database: PGlite plus the demo data).
 */
export function DemoBoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'loading' | 'ready' | Error>('loading');
  const [msg, setMsg] = useState('Starting…');
  useEffect(() => {
    onProgress(setMsg);
    Promise.all([serviceWorker(), ready()]).then(() => setState('ready'), (e) => setState(e as Error));
  }, []);

  if (state === 'ready') return <><DemoBar />{children}</>;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-accent-fg"><Utensils size={28} /></span>
      <h1 className="text-xl font-semibold">Aula Dining · demo</h1>
      {state === 'loading' ? (
        <p className="flex items-center gap-2 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> {msg}</p>
      ) : (
        <>
          <p className="text-sm text-bad">The demo could not start in this browser: {state.message}</p>
          <p className="text-xs text-muted">It needs a recent Chrome, Edge, Firefox or Safari, not a private window.</p>
          <button className="rounded-xl bg-fg px-4 py-2 text-sm font-medium text-bg" onClick={async () => { await resetDemo(); location.reload(); }}>Try again</button>
        </>
      )}
    </main>
  );
}

/** A slim strip on top of every page: whose phone this is, a switch to the other account, Reset. */
function DemoBar() {
  const [accounts, setAccounts] = useState<Awaited<ReturnType<typeof demoAccounts>> | null>(null);
  const [path, setPath] = useState('');
  useEffect(() => { demoAccounts().then(setAccounts).catch(() => undefined); setPath(location.pathname); }, []);
  if (!accounts || path.replace(BASE, '').startsWith('/login')) return null;
  const me = currentUser();
  const isStudent = me === accounts.student.id;
  const other = isStudent ? accounts.manager : accounts.student;
  const switchTo = () => {
    demoSignIn(other.id);
    location.href = withBase(isStudent ? '/admin' : '/me');
  };
  return (
    <div className="flex items-center gap-2 border-b border-border/70 bg-subtle px-3 py-1.5 text-xs">
      <span className="rounded-full bg-accent px-2 py-0.5 font-semibold text-accent-fg">Demo</span>
      <span className="min-w-0 flex-1 truncate text-muted">
        {me ? <>Viewing as <span className="font-medium text-fg">{isStudent ? 'student' : 'mess manager'}</span> · made-up data</> : 'Made-up data'}
      </span>
      {me && (
        <button onClick={switchTo} className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 font-medium">
          {isStudent ? <ClipboardCheck size={13} /> : <Ticket size={13} />} {isStudent ? 'Mess manager' : 'Student'}
        </button>
      )}
      <button
        onClick={async () => {
          if (!confirm('Reset the demo? Everything you changed is undone.')) return;
          await resetDemo();
          location.href = withBase('/login');
        }}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 font-medium" aria-label="Reset the demo data">
        <RotateCcw size={13} /> Reset
      </button>
    </div>
  );
}
