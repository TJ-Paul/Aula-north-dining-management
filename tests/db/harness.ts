import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const migrationsDir = join(root, 'supabase', 'migrations');

const stubSql = readFileSync(join(import.meta.dirname, 'supabase-stub.sql'), 'utf8');
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

export type Role = 'VIEWER' | 'STUDENT' | 'ATTENDANT' | 'ADMIN' | 'SUPER_ADMIN';
export type Result = { status: string; [key: string]: unknown };

/**
 * A fresh database with the Supabase stub and every migration applied.
 * Statements run as the `postgres` superuser unless wrapped in `as()`.
 */
export async function freshDb() {
  const pg = new PGlite();
  await pg.exec(stubSql);
  for (const sql of migrations) await pg.exec(sql);

  let userCount = 0;

  async function asUser<T>(userId: string | null, fn: () => Promise<T>, dbRole = 'authenticated'): Promise<T> {
    const claims = JSON.stringify(userId ? { sub: userId, role: dbRole } : { role: dbRole });
    await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
    await pg.exec(`set role ${dbRole}`);
    try {
      return await fn();
    } finally {
      await pg.exec('reset role');
      await pg.query(`select set_config('request.jwt.claims', '', false)`);
    }
  }

  const db = {
    pg,

    /** Creates an auth user (and, via trigger, its profile) with the given role. */
    async createUser(
      role: Role = 'STUDENT',
      opts: { name?: string; email?: string; emailConfirmed?: boolean; phone?: string; phoneConfirmed?: boolean } = {},
    ): Promise<string> {
      userCount += 1;
      const { rows } = await pg.query<{ id: string }>(
        `insert into auth.users (email, email_confirmed_at, phone, phone_confirmed_at, raw_user_meta_data)
         values ($1, case when $2 then now() end, $3, case when $4 then now() end, $5) returning id`,
        [
          opts.email ?? `user${userCount}@test.local`,
          opts.emailConfirmed ?? false,
          opts.phone ?? null,
          opts.phoneConfirmed ?? false,
          { full_name: opts.name ?? `User ${userCount}` },
        ],
      );
      const id = rows[0].id;
      if (role !== 'STUDENT') await pg.query(`update public.profiles set role = $1 where id = $2`, [role, id]);
      return id;
    },

    as: asUser,

    asAnon<T>(fn: () => Promise<T>) {
      return asUser(null, fn, 'anon');
    },

    /** Calls public.<fn>(...args) as the given user and returns its jsonb result. */
    async call(userId: string | null, fn: string, ...args: unknown[]): Promise<Result> {
      const params = args.map((_, i) => `$${i + 1}`).join(', ');
      return asUser(userId, async () => {
        const { rows } = await pg.query<{ r: Result }>(`select public.${fn}(${params}) as r`, args);
        return rows[0].r;
      });
    },

    /** Runs a query as the given user (RLS applies). */
    async select<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
      return asUser(userId, async () => (await pg.query<T>(sql, params)).rows);
    },

    /** Runs a query as the superuser (RLS bypassed). */
    async admin<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await pg.query<T>(sql, params)).rows;
    },
  };
  return db;
}

export type Db = Awaited<ReturnType<typeof freshDb>>;
