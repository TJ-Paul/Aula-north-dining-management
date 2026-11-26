import { redirect } from 'next/navigation';

// Feedback is at the bottom of the Mess tab now (2026-11-13).
export default function Page() {
  redirect('/mess');
}
