import { redirect } from 'next/navigation';

// Removed in the simpler app (2026-11-13); the records stay in the database.
export default function Page() {
  redirect('/admin');
}
