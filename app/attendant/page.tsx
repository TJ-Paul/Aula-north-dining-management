import type { Metadata } from 'next';
import { Door } from './door';

export const metadata: Metadata = { title: 'Door · Aula Dining' };

export default function AttendantPage() {
  return <Door />;
}
