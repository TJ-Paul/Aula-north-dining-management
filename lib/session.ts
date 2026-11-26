'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { forgetCache } from './use-load';
import { NetworkError, RpcError, UnauthenticatedError, rpc, setViewOnly } from './rpc';
import { withBase } from './base';
import { currentUser, setCurrentUser } from './demo/engine';

/** VIEWER: a view-only account (for professors and visitors); see supabase/migrations/20261106000100. */
export type Role = 'VIEWER' | 'STUDENT' | 'ATTENDANT' | 'ADMIN' | 'SUPER_ADMIN';

/** What my_profile() returns for the signed-in user. */
export type Session = {
  id: string;
  public_id: string;
  name: string;
  role: Role;
  is_verified: boolean;
  phone: string | null;
  student_id: string | null;
  avatar_url: string | null;
  room: string | null;
  roommates: Array<{ name: string; coupon_number?: string | null }>;
  coupon_number: number | null;
  coupon_since: string | null;
  update_requested_at: string | null;
  update_request_message: string | null;
  pending_claim: { claim_id: string; coupon_number: number; kind: 'INITIAL' | 'CHANGE'; requested_at: string } | null;
  last_decision: { status: 'REJECTED' | 'REVOKED'; coupon_number: number; reason: string | null; decided_at: string } | null;
  /** A view-only account: screens show it everything a super admin sees (role reads SUPER_ADMIN), the database refuses every change. */
  view_only?: boolean;
};

/** A viewer is shown every screen a super admin sees; the database still refuses any change they try. */
function asSeen(s: Session | null): Session | null {
  setViewOnly(s?.role === 'VIEWER');
  return s?.role === 'VIEWER' ? { ...s, role: 'SUPER_ADMIN', view_only: true } : s;
}

export const isStaff = (s: Session | null) => !!s && s.role !== 'STUDENT';
export const isAdmin = (s: Session | null) => !!s && (s.role === 'ADMIN' || s.role === 'SUPER_ADMIN');
/** Dev: the developers (role SUPER_ADMIN), who may change anything. */
export const isDev = (s: Session | null) => !!s && s.role === 'SUPER_ADMIN';
export const homeFor = (s: Session) => (s.role === 'STUDENT' ? '/me' : s.role === 'ATTENDANT' ? '/attendant' : '/admin');

/** What each role is called on screen. */
export const ROLE_LABEL: Record<Role, string> = {
  STUDENT: 'Student', ATTENDANT: 'Door staff', ADMIN: 'Mess manager', SUPER_ADMIN: 'Dev', VIEWER: 'Viewer',
};

// ---------------------------------------------------------------------------
// The signed-in profile is kept on the phone, so every screen opens at once with it and checks
// with the server in the background (at most every 2 minutes, or right away after a change).
// ---------------------------------------------------------------------------

const CACHE_KEY = 'aula-session-v1';
const FRESH_MS = 2 * 60000;
let memo: Session | null | undefined;
let memoAt = 0;
let inflight: Promise<Session | null> | null = null;

function remember(s: Session | null) {
  // Someone else signed in on this phone (or nobody is): drop what was kept for the last account.
  const before = memo === undefined ? cachedSession() : memo;
  if (before && before.id !== s?.id) forgetCache();
  memo = s;
  memoAt = Date.now();
  try {
    if (s) localStorage.setItem(CACHE_KEY, JSON.stringify(s));
    else localStorage.removeItem(CACHE_KEY);
  } catch { /* private mode */ }
}

/** The last known profile on this phone (no network), or null. */
export function cachedSession(): Session | null {
  if (memo !== undefined) return memo;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    memo = raw ? (JSON.parse(raw) as Session) : null;
  } catch { memo = null; }
  if (memo) setViewOnly(!!memo.view_only);
  return memo;
}

/** Forget the kept profile (sign-out, a different account signing in). */
export function forgetSession() {
  forgetCache();
  memo = undefined;
  memoAt = 0;
  try { localStorage.removeItem(CACHE_KEY); } catch { /* private mode */ }
}

// The demo: the visitor picked an account on the start page (lib/demo/engine.ts keeps which).
// The live app signs in with Supabase Auth; the profile comes from the database either way.
export function fetchSession(): Promise<Session | null> {
  // Screens opening together share one request.
  inflight ??= askSession().then((s) => { remember(s); return s; }).finally(() => { inflight = null; });
  return inflight;
}

async function askSession(): Promise<Session | null> {
  if (!currentUser()) return null;
  try {
    return asSeen(await rpc<Session | null>('my_profile'));
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null;
    throw e;
  }
}

/**
 * Everything personal on the student home screen in one call (my_home): the profile plus the
 * booking cards. Null when nobody is signed in.
 */
export async function fetchHome<T extends { profile: Session | null }>(): Promise<(Omit<T, 'profile'> & { session: Session }) | null> {
  if (!currentUser()) return null;
  let home: T;
  try {
    home = await rpc<T>('my_home');
  } catch (e) {
    if (e instanceof UnauthenticatedError) return null;
    throw e;
  }
  const session = asSeen(home.profile);
  remember(session);
  if (!session) return null;
  const { profile: _, ...rest } = home;
  return { ...rest, session };
}

/** The demo's "sign in": use one of the two demo accounts. */
export function demoSignIn(userId: string) {
  forgetSession();
  setCurrentUser(userId);
}

export async function signOut() {
  forgetSession();
  setCurrentUser(null);
}

const DEMO_ONLY = 'Accounts are fixed in this demo, so this is turned off. In the real app it works as usual.';

/** Account actions (passwords, staff accounts): the live app's server route. In the demo they are no-ops. */
export async function accountRoute<T = { status: string }>(action: string, _body: Record<string, unknown>): Promise<T> {
  if (action === 'close_login') return { status: 'OK' } as T;
  throw new RpcError(DEMO_ONLY);
}

/** Whether the first admin account still has to be created (never, in the demo). */
export async function setupNeeded() {
  return false;
}

/** Sign-in, sign-up, password changes: not part of the demo (the start page picks an account). */
export async function authAction<T = { status: string }>(_action: string, _body: Record<string, unknown>): Promise<T> {
  throw new RpcError(DEMO_ONLY);
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * The signed-in user (redirects to /login when there is none) and a way to refetch after changes.
 * Shows the profile kept on this phone straight away and checks it with the server in the background.
 */
export function useSessionWithReload() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const tries = useRef(0);
  const check = useCallback(async (force: boolean) => {
    if (!force && memo && Date.now() - memoAt < FRESH_MS) { setSession(memo); return; }
    let s: Session | null;
    try {
      s = await fetchSession();
    } catch (e) {
      // A slow or unreachable server is not "signed out": keep what is shown and try again,
      // waiting longer each time (2 s, 4 s, 8 s ... up to 30 s).
      if (e instanceof NetworkError) {
        const wait = Math.min(30000, 2000 * 2 ** tries.current++) * (0.8 + Math.random() * 0.4);
        setTimeout(() => check(true), wait);
        return;
      }
      s = null;
    }
    tries.current = 0;
    if (!s) {
      location.href = withBase('/login');
      return;
    }
    setSession(s);
  }, []);
  // Before the first paint: the kept profile, so there is no spinner between tabs.
  useIsoLayoutEffect(() => {
    const kept = cachedSession();
    if (kept) setSession(kept);
  }, []);
  useEffect(() => { check(false); }, [check]);
  const reload = useCallback(() => check(true), [check]);
  return { session, reload };
}

export function useSession() {
  return useSessionWithReload().session;
}
