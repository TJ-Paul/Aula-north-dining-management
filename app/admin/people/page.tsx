import { redirect } from 'next/navigation';

// Staff and roles now live in the Everyone tab.
export default function PeoplePage() {
  redirect('/admin/everyone?section=staff');
}
