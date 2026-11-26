'use client';

import { BellRing, Download, Share, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { enablePush, pushSupported } from '@/lib/push';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const DISMISS_KEY = 'aula-setup-dismissed';
const isStandalone = () => typeof window !== 'undefined'
  && (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
const isIos = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

// Chrome offers installing once per page load; keep the offer for whenever the button is pressed.
let installEvent: InstallEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e as InstallEvent; });
}

/**
 * "Get the app" and "Turn on notifications", until both are done. The app then opens from the home
 * screen like any other, and notices arrive with a sound and vibration even with the phone face down.
 */
export function AppSetup({ compact }: { compact?: boolean }) {
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(true);
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [hidden, setHidden] = useState(true);
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setPerm(pushSupported() ? Notification.permission : 'unsupported');
    try { setHidden(localStorage.getItem(DISMISS_KEY) === '1'); } catch { setHidden(false); }
    setCanInstall(!!installEvent);
    const onPrompt = () => setCanInstall(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const needInstall = !installed && (canInstall || isIos());
  const needPush = perm === 'default';
  if ((!needInstall && !needPush) || (hidden && compact)) return null;

  const install = async () => {
    if (installEvent) { await installEvent.prompt(); await installEvent.userChoice; installEvent = null; setCanInstall(false); setInstalled(isStandalone()); }
    else setIosHelp(true);
  };

  return (
    <section className="relative grid gap-3 rounded-2xl border border-accent/40 bg-accent-soft/50 p-4">
      {compact && (
        <button onClick={() => { setHidden(true); try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ } }}
          aria-label="Not now" className="absolute right-2 top-2 rounded-full p-1.5 text-muted hover:bg-surface"><X size={16} /></button>
      )}
      <p className="pr-6 text-sm font-medium">Never miss booking or the gate opening</p>
      <div className="flex flex-wrap gap-2">
        {needInstall && (
          <button onClick={install} className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg">
            <Download size={16} /> Get the app
          </button>
        )}
        {needPush && (
          <button onClick={async () => setPerm(await enablePush())}
            className="flex min-h-11 items-center gap-2 rounded-xl bg-surface px-4 text-sm font-medium ring-1 ring-border">
            <BellRing size={16} /> Turn on notifications
          </button>
        )}
      </div>
      {iosHelp && (
        <p className="flex items-start gap-2 text-sm text-muted">
          <Share size={16} className="mt-0.5 shrink-0" /> On iPhone: tap Share in Safari, then “Add to Home Screen”. Open the app from there to turn on notifications.
        </p>
      )}
    </section>
  );
}

/** Profile row, only while notifications are blocked in the browser ("Turn on" itself is in AppSetup). */
export function NotificationsRow() {
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('unsupported');
  useEffect(() => { setPerm(pushSupported() ? Notification.permission : 'unsupported'); }, []);
  if (perm !== 'denied') return null;
  return (
    <div className="card flex items-center gap-3">
      <BellRing size={18} className="text-warn" />
      <span className="flex-1">
        <span className="block font-medium">Notifications are blocked</span>
        <span className="block text-xs text-muted">Allow notifications for this site in the browser’s settings to get booking and gate alerts.</span>
      </span>
    </div>
  );
}
