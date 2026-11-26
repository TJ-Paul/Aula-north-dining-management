/** The admin's mark for a student with 3 or more missed meals in the last 30 days (amendment 1.4). */
export function MissedMark({ count }: { count?: number }) {
  return (
    <span className="shrink-0 rounded-full bg-bad-soft px-2 py-0.5 text-xs font-medium text-bad" title="Missed meals in the last 30 days">
      {count ?? 3} missed · 30 days
    </span>
  );
}
