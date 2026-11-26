'use client';

import { currentUser, demoRpc, demoShared, demoTool, type DemoAction } from '@/lib/demo/engine';

// Every database operation the app performs is a call to one SQL function
// (see supabase/migrations). In this demo those calls go to the same database
// running inside the browser (lib/demo/engine.ts); the live app sends them to Supabase.

/** The demo tools on the manager dashboard are shown (the live app hides them). */
export const LOCAL_MODE = true;

/** The request never reached the server (offline, DNS, captive portal...). */
export class NetworkError extends Error {}
/** The server refused the call (permissions, bad input). */
export class RpcError extends Error {}
/** Nobody is signed in. */
export class UnauthenticatedError extends RpcError {}

/** Shown when a view-only account presses something that would change data. */
export const VIEW_ONLY_MESSAGE = 'This is a view-only account, so nothing was changed.';
let viewOnlyAccount = false;
/** Set from the signed-in profile (lib/session.ts). */
export function setViewOnly(on: boolean) { viewOnlyAccount = on; }
export function viewOnly() { return viewOnlyAccount; }
/** The database answers a viewer's change with a read-only error (see 20261106000100_viewer_accounts.sql). */
const friendly = (message: string) => (/read-only transaction/i.test(message) ? VIEW_ONLY_MESSAGE : message);

// ---------------------------------------------------------------------------
// Busy server protection (after the 2026-11-07 freeze). Every call gives up after
// TIMEOUT_MS instead of hanging, and each slow or failed call raises a "strain" level
// that makes every screen's polling wait longer (lib/poll.ts); quick answers lower it.
// ---------------------------------------------------------------------------

let strain = 0;

/** How many times longer than usual screens should wait between refreshes: 1, 2, 4 or 8. */
export function serverStrain() { return 2 ** strain; }

function note(ok: boolean, ms: number) {
  if (!ok || ms > 4000) strain = Math.min(3, strain + 1);
  else if (ms < 1500) strain = Math.max(0, strain - 1);
  reportReach(ok);
}

// ---------------------------------------------------------------------------
// Bad networks (hall Wi-Fi, mobile data at the gate): screens hear whether the last call got through,
// so a small "offline" pill can show and everything can refresh the moment the connection is back.
// ---------------------------------------------------------------------------

let reachable = true;
function reportReach(ok: boolean) {
  if (ok === reachable || typeof window === 'undefined') return;
  reachable = ok;
  window.dispatchEvent(new CustomEvent('aula-reach', { detail: ok }));
}
/** Whether the last call reached the server. */
export function serverReachable() { return reachable; }

/**
 * For presses that are safe to send twice (booking, cancelling, a coupon at the door): when the
 * connection drops, try again by itself (after about 1, 2 and 4 s) instead of failing. `onRetry` lets the
 * screen say "Connecting…". Business answers (FULL, ALREADY_BOOKED...) come back as usual.
 */
export async function rpcRetry<T>(fn: string, args: Record<string, unknown>, onRetry?: (attempt: number) => void, tries = 4): Promise<T & { retried?: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await rpc<T>(fn, args);
      return (attempt > 0 && r && typeof r === 'object' ? { ...r, retried: true } : r) as T & { retried?: boolean };
    } catch (e) {
      if (!(e instanceof NetworkError) || attempt >= tries - 1) throw e;
      onRetry?.(attempt + 1);
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** attempt * (0.8 + Math.random() * 0.4)));
    }
  }
}


/** Errors from the database, as the screens expect them. */
async function demoCall<T>(fn: () => Promise<unknown>): Promise<T> {
  const started = Date.now();
  try {
    const r = (await fn()) as T;
    note(true, Date.now() - started);
    return r;
  } catch (e) {
    note(true, Date.now() - started);
    throw new RpcError(friendly((e as Error).message));
  }
}

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const user = currentUser();
  if (!user) throw new UnauthenticatedError('Not signed in');
  // The two demo accounts must stay (Reset brings back everything else).
  if (fn === 'delete_my_account') throw new RpcError('The demo accounts can’t be deleted. In the real app this deletes your account.');
  return demoCall<T>(() => demoRpc(user, fn, args));
}

/** The part of a meal's booking state that is the same for everyone (open batch, seats taken, last filled batch). */
export function mealLive<T>(mealId: string): Promise<T> {
  return demoCall<T>(() => demoShared('meal_live_state', { p_meal_service_id: mealId }));
}

/** The home screen's meal list with menus (the same for everyone). */
export function mealsLive<T>(): Promise<T> {
  return demoCall<T>(() => demoShared('meals_timeline', {}));
}

/** Demo tools: run a feast in minutes, simulate a crowd. */
export function testingTool<T = { status: string }>(action: DemoAction) {
  const user = currentUser();
  if (!user) return Promise.reject(new UnauthenticatedError('Not signed in'));
  return demoCall<T>(() => demoTool(user, action));
}
