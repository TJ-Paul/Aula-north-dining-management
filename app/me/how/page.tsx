'use client';

import { ArrowLeft, DoorOpen, MessageSquareText, Sparkles, Ticket, Utensils } from 'lucide-react';
import Link from 'next/link';
import { PageSkeleton } from '@/components/skeleton';
import { AppFrame } from '@/components/top-bar';
import { useSession } from '@/lib/session';

/** The rules in one place, so the everyday screens can stay short. */
export default function HowPage() {
  const session = useSession();
  if (!session) return <PageSkeleton />;
  return (
    <AppFrame session={session} active="profile">
      <Link href="/me/profile" className="flex w-fit items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft size={14} /> Profile</Link>
      <h1 className="text-2xl font-semibold tracking-tight">How it works</h1>

      <Section icon={Utensils} title="Lunch and dinner">
        <li>No booking. Just come and eat.</li>
        <li>A mess manager ticks who ate afterwards; you get a notification and it shows under My Meals.</li>
      </Section>

      <Section icon={Sparkles} title="Improvement, feast and paron">
        <li>Served in batches of a set number of seats.</li>
        <li>Booking for batch 1 opens <b>15 minutes</b> before the start. A booking is a seat, never a waiting list.</li>
        <li>Once every seat is booked, a few more can take a <b>Lucky?</b> place: you wait outside and go in after the booked students.</li>
        <li>When a batch is filled, the managers open booking for the next one. Everyone gets a notification.</li>
      </Section>

      <Section icon={DoorOpen} title="At the gate">
        <li>When the gate opens, come. Booked students go in first, then Lucky?, then anyone else while there is room.</li>
        <li>When the room is full, the gate closes (“Filled”). A mess manager comes to your table and takes your coupon number.</li>
        <li>When the room starts to empty, booking opens for the next batch. Everyone gets a notification.</li>
        <li>Can’t come? Tap “Cancel booking” so someone else gets the seat.</li>
      </Section>

      <Section icon={MessageSquareText} title="Feedback">
        <li>Send feedback, complaints or suggestions at the bottom of the Mess tab. It is anonymous.</li>
        <li>Answers from the mess managers show there for everyone.</li>
      </Section>

      <Section icon={Ticket} title="Your coupon">
        <li>Your coupon number is your hall identity. A mess manager checks it against the hall register.</li>
      </Section>
    </AppFrame>
  );
}

function Section({ icon: Icon, title, children }: { icon: typeof Ticket; title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="mb-2 flex items-center gap-2 font-semibold"><Icon size={18} className="text-accent" aria-hidden /> {title}</h2>
      <ul className="grid list-disc gap-1 pl-5 text-sm">{children}</ul>
    </section>
  );
}
