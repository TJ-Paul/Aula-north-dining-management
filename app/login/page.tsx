'use client';

import { ArrowRight, ClipboardCheck, ShieldCheck, Ticket, Utensils } from 'lucide-react';
import { useEffect, useState } from 'react';
import { withBase } from '@/lib/base';
import { demoAccounts } from '@/lib/demo/engine';
import { demoSignIn, homeFor, type Role } from '@/lib/session';

type Accounts = Awaited<ReturnType<typeof demoAccounts>>;

/**
 * The demo's start page. The real app signs in with a coupon number or student ID and a password;
 * here a visitor simply picks whose phone to look through.
 */
export default function StartPage() {
  const [accounts, setAccounts] = useState<Accounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { demoAccounts().then(setAccounts).catch((e) => setError((e as Error).message)); }, []);

  const go = (id: string, role: Role) => {
    demoSignIn(id);
    location.href = withBase(homeFor({ role } as Parameters<typeof homeFor>[0]));
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-4 py-8 sm:max-w-xl">
      <div className="flex items-center gap-3">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-fg"><Utensils size={24} /></span>
        <div>
          <h1 className="text-2xl font-semibold">Aula Dining</h1>
          <p className="text-sm text-muted">Smart mess dining for a university hall</p>
        </div>
      </div>

      <p className="text-sm text-muted">
        This is a working demo of the whole app. Everything runs inside your browser — the real database,
        with made-up students and a few weeks of meals — so press any button you like. Nothing leaves this
        page, and <span className="font-medium text-fg">Reset</span> (top of every page) brings the data back.
      </p>

      {error && <p className="text-sm text-bad" role="alert">The demo could not start: {error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Choice disabled={!accounts} onClick={() => accounts && go(accounts.student.id, 'STUDENT')} icon={Ticket} title="Explore as a student" />
        <Choice disabled={!accounts} onClick={() => accounts && go(accounts.manager.id, 'ADMIN')} icon={ClipboardCheck} title="Explore as a mess manager" />
      </div>

      <p className="flex items-start gap-2 text-xs text-muted">
        <ShieldCheck size={14} className="mt-0.5 shrink-0" />
        All names, student IDs, coupon numbers and phone numbers here are made up. You can switch between the two
        accounts at any time.
      </p>
    </main>
  );
}

function Choice({ icon: Icon, title, onClick, disabled }: {
  icon: typeof Ticket; title: string; onClick: () => void; disabled: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="card flex items-center gap-3 text-left transition hover:bg-subtle active:scale-[0.99] disabled:opacity-60">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-accent"><Icon size={20} /></span>
      <span className="flex-1 font-semibold">{title}</span>
      <ArrowRight size={16} className="shrink-0 text-muted" />
    </button>
  );
}
