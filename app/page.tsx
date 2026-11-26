'use client';

import { useEffect } from 'react';
import { PageSkeleton } from '@/components/skeleton';
import { cachedSession, fetchSession, homeFor } from '@/lib/session';
import { withBase } from '@/lib/base';

/** Sends each user to their own screen: at once with the profile kept on the phone, else after asking. */
export default function Home() {
  useEffect(() => {
    const kept = cachedSession();
    if (kept) { location.replace(withBase(homeFor(kept))); return; }
    fetchSession()
      .then((s) => location.replace(withBase(s ? homeFor(s) : '/login')))
      .catch(() => location.replace(withBase('/login')));
  }, []);
  return <PageSkeleton />;
}
