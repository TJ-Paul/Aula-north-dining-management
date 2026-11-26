'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppSetup } from '@/components/app-setup';
import { CouponStatus } from '@/components/coupon-status';
import { type MealBrief } from '@/components/meal-card';
import { type Seating } from '@/components/meal-booking';
import { NominationCard } from '@/components/nomination-card';
import { PageSkeleton } from '@/components/skeleton';
import { StudentMeals } from '@/components/student-meals';
import { AppFrame } from '@/components/top-bar';
import { NetworkError, mealsLive } from '@/lib/rpc';
import { cachedSession, fetchHome, type Session } from '@/lib/session';
import { pollWhileVisible } from '@/lib/poll';
import { freshWithin, keep, readKept } from '@/lib/use-load';
import { withBase } from '@/lib/base';

type Home = {
  profile: Session | null;
  seating: Record<string, Seating>;
  missed: { count: number; window_days: number; marked: boolean };
};

/** No connection: the saved meals stay on screen and a pill says so (see AppFrame). */
const NET = 'No connection. Trying again…';


/**
 * Meals (the home screen): today first and biggest, then the meals planned ahead; the last week stays
 * folded behind "Earlier meals" (already loaded, so opening it asks nothing).
 *
 * Opening it costs two calls (so 450 phones opening together stay cheap): the meal list from
 * /api/meals-live (cached, the same for everyone) and everything personal from my_home. Both are
 * kept on the phone, so the screen shows at once and refreshes in the background. Every 2 minutes
 * only the cached list is refreshed; the personal part every 5 minutes.
 */
export default function MealsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [board, setBoard] = useState<MealBrief[] | undefined>(undefined);
  const [home, setHome] = useState<Omit<Home, 'profile'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tries = useRef(0);
  const homeAt = useRef(0);

  useLayoutEffect(() => {
    const s = cachedSession();
    if (s) setSession(s);
    const b = readKept<MealBrief[]>('meals');
    if (b) setBoard(b);
    const h = readKept<Omit<Home, 'profile'>>('home');
    if (h) setHome(h);
  }, []);

  const loadHome = useCallback(async () => {
    try {
      const [b, h] = await Promise.all([mealsLive<{ meals: MealBrief[] }>(), fetchHome<Home>()]);
      if (!h) { location.href = withBase('/login'); return; }
      const { session: s, ...rest } = h;
      if (s.role !== 'STUDENT' && s.coupon_number === null) { location.replace(withBase(s.role === 'ATTENDANT' ? '/attendant' : '/admin')); return; }
      setSession(s);
      setHome(rest);
      setBoard(b.meals);
      keep('meals', b.meals);
      keep('home', rest);
      setError(null);
      tries.current = 0;
      homeAt.current = Date.now();
    } catch (e) {
      setError(e instanceof NetworkError ? NET : (e as Error).message);
      // Nothing fresh yet: try again, waiting longer each time (2 s, 4 s, 8 s ... up to 30 s).
      if (!homeAt.current) setTimeout(loadHome, Math.min(30000, 2000 * 2 ** tries.current++) * (0.8 + Math.random() * 0.4));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (Date.now() - homeAt.current > 5 * 60000) return loadHome();
    try {
      const b = (await mealsLive<{ meals: MealBrief[] }>()).meals;
      setBoard(b);
      keep('meals', b);
      setError(null);
    } catch (e) {
      setError(e instanceof NetworkError ? NET : (e as Error).message);
    }
  }, [loadHome]);

  useEffect(() => {
    // Back on this tab within a minute: what is shown is fresh enough, ask nothing.
    if (freshWithin('home', 60000) && readKept('meals')) homeAt.current = Date.now(); else loadHome();
    return pollWhileVisible(refresh, 2 * 60000);
  }, [loadHome, refresh]);

  if (!session || board === undefined) {
    return <PageSkeleton error={error} />;
  }

  return (
    <AppFrame session={session} active="me">
      <AppSetup compact />
      <NominationCard onDone={loadHome} />
      {(!session.coupon_number || session.update_requested_at || session.pending_claim) && (
        <CouponStatus session={session} onChanged={loadHome} compact />
      )}

      <StudentMeals board={board} seating={home?.seating} />
      {error && error !== NET && <p className="text-center text-sm text-muted" role="status">{error}</p>}
    </AppFrame>
  );
}
