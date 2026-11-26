'use client';

import { serverStrain } from '@/lib/rpc';

/**
 * Calls `fn` about every `ms` milliseconds, but only while the app is on screen: nothing is
 * downloaded while the phone is locked or another app (or tab) is in front. Coming back
 * refreshes at once, so nobody sees stale information. Returns the stop function.
 *
 * Built so that hundreds of phones can't pile onto a busy server (the 2026-11-07 freeze):
 * - the next call is only planned once the last one has finished, so calls never stack up;
 * - when the server is slow or failing, the wait doubles (up to 8×, at most a minute);
 * - every wait is shifted by a random ±15%, so phones don't all ask at the same instant.
 */
export function pollWhileVisible(fn: () => unknown, ms: number): () => void {
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const plan = () => {
    if (stopped) return;
    clearTimeout(timer);
    const wait = Math.min(Math.max(ms, 60000), ms * serverStrain()) * (0.85 + Math.random() * 0.3);
    timer = setTimeout(run, wait);
  };
  async function run() {
    if (stopped || running) return;
    if (hidden()) return plan();
    running = true;
    try { await fn(); } catch { /* the caller shows its own errors */ }
    running = false;
    plan();
  }

  const onShow = () => { if (!hidden() && !running) run(); };
  document.addEventListener('visibilitychange', onShow);
  // The connection came back: refresh now rather than at the next planned time.
  window.addEventListener('online', onShow);
  plan();
  return () => {
    stopped = true; clearTimeout(timer);
    document.removeEventListener('visibilitychange', onShow);
    window.removeEventListener('online', onShow);
  };
}
