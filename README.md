# Aula Dining — smart mess dining

Aula Dining is a phone-first web app that runs the dining hall of Aula North, a university residence hall. It
covers the daily meals and menus, special meals ("improvements" and feasts) served in batches with seat
booking, coupon collection, attendance, notices and anonymous feedback.

**Live demo: [tj-paul.github.io/Aula-north-dining-management](https://tj-paul.github.io/Aula-north-dining-management/)**

This is not a class project or a mock-up. Aula Dining is an active system that the residents of Aula North use
regularly for their meals, and that the mess managers use to run the dining hall. This repository is a public
copy of it with made-up data, so anyone can try every feature.

## The problem it solves

The dining hall seats about 50 people, but a hall full of students wants to eat at the same time, especially
on special meal nights. Before this app, everyone rushed the gate at once on feast nights. Whoever pushed
hardest got in first, and nobody knew how long they would have to wait.

The mess managers took coupons by hand and kept no record of who ate, so counting heads, planning the food and
settling the mess month came down to guesswork. Menus, timings, changes and news like "seats are free now"
travelled by word of mouth or Facebook posts that many people missed. Choices such as chicken instead of mutton
had to be collected one by one, and feedback reached the managers only in person, if at all.

Aula Dining replaces the scramble with a seat. Special meals are served in batches, and booking for each batch
opens on the phone. A booking is a seat, so there is no reason to queue early or push. When a batch is full the
managers press Filled, then open bookings for the next batch, and everyone sees a live stopwatch for each step.
A few extra "Lucky?" places wait just outside in case someone does not turn up.

Each student's coupon number is their hall identity. Coupons are typed into the app as students come in, so
the hall knows exactly who ate at every meal, with no paper. Today's meals, the menus for the coming weeks,
meal choices with deadlines, notices and notifications all reach every resident's phone. The managers get a
clear picture of who is booked, who came in and who joined without booking, the meals of each mess month, and
an anonymous feedback inbox they can reply to.

## About this demo

Nothing in this demo is connected to a server. The real database runs inside your browser, filled with
made-up students and a few weeks of meals. Press any button you like: your changes stay in your browser only,
and Reset at the top of every page brings the original demo data back.

On the start page you choose whose phone to look through. As a student you can see today's meals and the
coming weeks, book a seat for a special meal, choose chicken instead of mutton, look back at what you ate day
by day, and read the mess months, notices, your profile and roommates, and send anonymous feedback. As a mess
manager you can create meals with menus and posters, run a feast batch by batch, take coupons inside the dining
hall, approve coupon claims against the hall register, and look through the students database, attendance,
the feedback inbox and notices.

The Demo tools at the bottom of the manager dashboard let you live through a whole special meal in a few
minutes. Start a demo feast, let twenty made-up students book, skip the clock ahead, let them come in, then
press Filled, Start taking bookings and Gate open. Switch to the student account in the top bar to see the same
meal from a student's phone.

## How it works

The app is built with Next.js, React and Tailwind CSS, and this demo is exported as a static site for GitHub
Pages. The database is PostgreSQL, and all the rules live in SQL as constraints, triggers and functions in
[`supabase/migrations`](supabase/migrations). The live app runs them on Supabase. This demo runs the very same
migrations in your browser with [PGlite](https://pglite.dev), which is Postgres compiled to WebAssembly, and
saves the data in IndexedDB.

Screens never touch the tables directly. Every action is one call to a SQL function, made in
[`lib/rpc.ts`](lib/rpc.ts). In this demo those calls go to [`lib/demo/engine.ts`](lib/demo/engine.ts) instead
of the network, as the signed-in demo user and with the same permission checks. The demo data was made on one
day, and on each visit every date is moved so that day becomes today, so there is always a lunch, a dinner and
an upcoming feast to look at. Running `npm test` checks the database rules in [`tests/db`](tests/db) against
PGlite.

## Privacy

The demo data comes from the real system with everything personal replaced. Names are made-up Bengali names.
Student IDs keep only their batch, moved up by 20 (so 23… becomes 43…), and the rest of each ID is random.
Coupon numbers are shuffled, phone numbers and rooms are invented, photos are removed, and the notices and
feedback were rewritten. The demo database is built fresh from the migrations, so none of the original rows
are inside it.

## Run it yourself

Install the packages with `npm install`, then run `npm run dev` to open the app at http://localhost:3000.
`npm run build` makes the static site in the `out` folder, and `npm test` runs the database rule tests.

To publish your own copy, push this folder to a GitHub repository, set Settings → Pages → Source to GitHub
Actions, and the workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds and publishes
the site on every push.
