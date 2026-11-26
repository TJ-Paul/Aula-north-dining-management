# Aula Dining — smart mess dining (demo)

A phone-first web app that runs the dining hall of a university residence hall: daily meals and menus,
special meals ("improvements" and feasts) served in batches with seat booking, coupon collection, attendance,
notices and anonymous feedback.

**▶ Live demo:** `https://<your-github-username>.github.io/<this-repository>/`

This repository is a **public, self-contained demo** of the real app. Nothing is connected to a server:
the real database runs *inside your browser*, filled with made-up students and a few weeks of meals.
Press any button — your changes stay in your browser only, and **Reset** (top of every page) brings the
original demo data back.

## Try it

On the start page, pick whose phone to look through:

| As a **student** | As a **mess manager** |
| --- | --- |
| Today's meals and menus, the coming weeks | Dashboard of today: who is booked, who came in, the gate stopwatch |
| Book a seat for a special meal (batches of seats; "Lucky?" places once a batch is full) | Create meals, menus with alternatives, posters (the **+** button) |
| Choose chicken instead of mutton before the meal | Run a feast batch by batch: *Filled → Start taking bookings → Gate open* |
| My meals: what you ate, day by day | Take coupons inside the dining hall (the Door screen) |
| Mess months, mess managers, notices | Approve coupon claims against the hall register |
| Profile, roommates, anonymous feedback | Students database, attendance, feedback inbox, notices to everyone |

**Demo tools** (bottom of the manager dashboard) let you live through a whole special meal in a few
minutes: start a demo feast, let 20 made-up students book, skip the clock ahead, let them come in, then press
*Filled*, *Start taking bookings* and *Gate open*. Switch to the student (top bar) to see the same meal from a
student's phone.

## How it works

- **Frontend:** Next.js (App Router, React 19, Tailwind CSS 4), exported as a static site for GitHub Pages.
- **Database:** PostgreSQL. All rules live in SQL — constraints, triggers and `SECURITY DEFINER` functions in
  [`supabase/migrations`](supabase/migrations). The live app runs them on Supabase; this demo runs the very
  same migrations in the browser with [PGlite](https://pglite.dev) (Postgres compiled to WebAssembly),
  saved in IndexedDB.
- **Screens never touch tables:** every action is one call to a SQL function ([`lib/rpc.ts`](lib/rpc.ts)). In
  this demo those calls go to [`lib/demo/engine.ts`](lib/demo/engine.ts) instead of the network, as the
  signed-in demo user, with the same permission checks.
- **Dates move with you:** the demo data was made on one day; on each visit every date is moved so that day
  is *today*, so there is always a lunch, a dinner and an upcoming feast.
- **Tests:** `npm test` runs the database rule tests ([`tests/db`](tests/db)) against PGlite.

## Privacy

The demo data is derived from the real system, with everything personal replaced: names are made-up
Bengali names, student IDs keep only their batch (moved up by 20, e.g. 23… → 43…) with the rest random,
coupon numbers are shuffled, phone numbers and rooms are invented, photos are removed, and free-text notices
and feedback were rewritten. The demo database is built fresh from the migrations, so nothing of the original
rows is inside it.

## Run it yourself

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # static site in out/
npm test           # database rule tests
```

## Publish on GitHub Pages

1. Push this folder to a new GitHub repository (branch `main`).
2. In the repository: **Settings → Pages → Source: GitHub Actions**.
3. The workflow in [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds and publishes the site
   on every push. The link appears in **Settings → Pages** and on the workflow run.
