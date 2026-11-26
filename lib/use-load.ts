'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pollWhileVisible } from '@/lib/poll';

// Answers kept on the phone under a name (opts.cache): a screen opened again shows its last answer at
// once and refreshes it in the background, so going back and forth between tabs never waits.
// Cleared on sign-out (forgetCache, called by lib/session.ts).
const PREFIX = 'aula-c:';
const memory = new Map<string, unknown>();
/** When each answer was last fetched in this app session (answers read back from storage count as old). */
const fetchedAt = new Map<string, number>();

/** Whether `key` was fetched within `ms` (then a screen opened again needn't ask). */
export function freshWithin(key: string, ms: number) {
  return Date.now() - (fetchedAt.get(key) ?? 0) < ms;
}

export function readKept<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw) { const v = JSON.parse(raw) as T; memory.set(key, v); return v; }
  } catch { /* private mode or bad JSON */ }
  return undefined;
}

export function keep(key: string, value: unknown) {
  memory.set(key, value);
  fetchedAt.set(key, Date.now());
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* full or private mode */ }
}

/** Forget every kept answer (sign-out). */
export function forgetCache() {
  memory.clear();
  fetchedAt.clear();
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
    }
  } catch { /* private mode */ }
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Loads data with `fn`, optionally re-polling every `intervalMs`, and exposes
 * `reload` for after a change. Keeps the last good data on a failed poll.
 * `cache`: a name to keep the answer under on this phone (see above); a screen opened again within
 * `fresh` ms (default 60 s) of the last fetch shows the kept answer without asking the server.
 */
export function useLoad<T>(fn: (() => Promise<T>) | null, intervalMs?: number, opts: { lazy?: boolean; cache?: string; fresh?: number } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cacheKey = opts.cache;

  useIsoLayoutEffect(() => {
    if (!cacheKey) return;
    const kept = readKept<T>(cacheKey);
    setData(kept);
  }, [cacheKey]);

  const reload = useCallback(async () => {
    if (!fnRef.current) return;
    try {
      const v = await fnRef.current();
      setData(v);
      setError(null);
      if (cacheKey) keep(cacheKey, v);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [cacheKey]);

  const enabled = fn !== null;
  const lazy = !!opts.lazy;
  const freshMs = opts.fresh ?? 60000;
  useEffect(() => {
    if (!enabled) return;
    let stop: (() => void) | undefined;
    const begin = () => {
      if (!cacheKey || !freshWithin(cacheKey, freshMs)) reload();
      if (intervalMs) stop = pollWhileVisible(reload, intervalMs);
    };
    // Lazy: extras nobody needs in the first second (points, nominations) start 2–8 s later, at a
    // random moment, so hundreds of phones opening the app together don't all ask at once.
    const t = lazy ? setTimeout(begin, startDelay()) : undefined;
    if (!lazy) begin();
    return () => { clearTimeout(t); stop?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, reload, lazy]);

  return { data, error, reload };
}

/** A random 2–8 s wait before loading extras (see `lazy`). */
export const startDelay = () => 2000 + Math.random() * 6000;
