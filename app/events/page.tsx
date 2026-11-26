import { redirect } from 'next/navigation';

// Events live on the Meals tab now (2026-11-13).
export default function Page() {
  redirect('/me');
}
