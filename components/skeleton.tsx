/**
 * Loading placeholders shaped like the screen that is coming, so the first open feels quick and
 * nothing jumps when the data arrives. (Later opens show the copy kept on the phone at once.)
 */
export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="card flex items-start gap-3" aria-hidden>
      <span className="size-14 shrink-0 animate-pulse rounded-2xl bg-subtle" />
      <span className="grid flex-1 gap-2 pt-1">
        <span className="h-4 w-2/5 animate-pulse rounded-full bg-subtle" />
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className="h-3 animate-pulse rounded-full bg-subtle" style={{ width: `${70 - i * 18}%` }} />
        ))}
      </span>
    </div>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-3" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

/** A whole screen still loading: header bar, a title and a few cards. */
export function PageSkeleton({ error }: { error?: string | null }) {
  return (
    <div className="min-h-dvh">
      <div className="h-14 border-b border-border pt-[env(safe-area-inset-top)]" />
      <main className="mx-auto grid max-w-3xl gap-4 px-4 pt-5">
        <span className="h-7 w-40 animate-pulse rounded-full bg-subtle" />
        <SkeletonList count={3} />
        {error && <p className="text-center text-sm text-muted" role="status">{error}</p>}
      </main>
    </div>
  );
}
