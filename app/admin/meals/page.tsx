'use client';

import { useEffect, useRef, useState } from 'react';
import { AdminShell, Badge, ConfirmButton, Empty, Notice } from '@/components/admin-shell';
import { MealEditor, itemsJson, saveMealExtras, toTimestamps, type MealForm } from '@/components/meal-editor';
import { type Meal, formFor, hhmm, menuOf } from '@/components/edit-meal-sheet';
import { ComingCount } from '@/components/coming';
import { DayCard, MealCard, groupDays } from '@/components/meal-card';
import { Button } from '@/components/sheet';
import { SkeletonList } from '@/components/skeleton';
import { dhakaDate, dhakaToday, timeRange } from '@/lib/format';
import { rpc } from '@/lib/rpc';
import { useLoad } from '@/lib/use-load';

type Aisle = { aisle: 'A' | 'B'; readiness: string; display_state: string; meal_service_id: string | null; wave_number: number | null };
type Policy = { version: number; note: string | null; is_active: boolean; settings: Record<string, number> };
type Data = { meals: Meal[]; aisles: Aisle[]; policies: Policy[] };

const OUTCOME: Record<string, string> = {
  CREATED: 'Meal created.', EXISTS: 'This date already has that meal (one lunch and one dinner a day). Edit it instead, or choose Paron for an extra special meal.', OK: 'Saved.',
  BREAKFAST_NOT_USED: 'Breakfast is not used; use Paron for a special morning meal.',
  END_BEFORE_START: 'The end time must be after the start.', MEAL_CLOSED: 'That meal is closed and can no longer be edited.',
};

export default function MealsPage() {
  return <AdminShell active="meals">{() => <Meals />}</AdminShell>;
}

function Meals() {
  const { data, error, reload } = useLoad(() => rpc<Data>('admin_meal_services', { p_limit: 30 }), 10000);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const saveExtras = async (mealId: string, f: MealForm) => {
    const warn = await saveMealExtras(mealId, f);
    if (warn) setNote(warn);
    await reload();
  };

  const act = async (label: string, fn: () => Promise<{ status: string } & Record<string, unknown>>, explain?: Record<string, string>) => {
    setBusy(true);
    try {
      const r = await fn();
      const detail = (r.details as { status?: string } | undefined)?.status;
      setNote(explain?.[r.status] ?? OUTCOME[r.status] ?? `${label}: ${r.status.replaceAll('_', ' ').toLowerCase()}`);
      if (detail && detail !== 'OK') setNote(OUTCOME[detail] ?? detail);
      await reload();
      return r.status;
    } catch (e) {
      setNote(`${label} failed: ${(e as Error).message}`);
      return 'ERROR';
    } finally {
      setBusy(false);
    }
  };

  // From the Dashboard's Edit: open that meal's editor straight away (once).
  const opened = useRef(false);
  useEffect(() => {
    if (!data || opened.current) return;
    opened.current = true;
    const id = new URLSearchParams(location.search).get('edit');
    if (!id || !data.meals.some((m) => m.id === id)) return;
    setExpanded(id);
    setEditing(id);
    setTimeout(() => document.getElementById(`meal-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 100);
  }, [data]);

  if (!data) return error ? <Empty>{error}</Empty> : <SkeletonList count={4} />;

  return (
    <>
      <Notice text={note} />

      <h2 className="mt-2 px-1 text-xs font-semibold uppercase tracking-wider text-muted">Tap a meal to edit or delete it</h2>
      {data.meals.length === 0 ? <Empty>No meals yet.</Empty> : (
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {groupDays(data.meals.map((m) => ({ ...m, menu: menuOf(m) })), undefined, { specials: true }).map((g) => {
              const todayDhaka = dhakaToday();
              const started = (m: Meal) => new Date(m.service_start_at).getTime() <= Date.now();
              // Before today is past even if nobody closed it (lunch and dinner stay open until a manager does).
              const earlierDay = (m: Meal) => m.service_date < todayDhaka;
              const past = (m: Meal) => started(m) && (m.state !== 'IN_SERVICE' || earlierDay(m));
              const select = (m: Meal) => { setExpanded(expanded === m.id ? null : m.id); setEditing(null); };
              const aside = (m: Meal) => <>
                {m.state === 'IN_SERVICE' && !earlierDay(m) && <Badge tone="ok">Serving</Badge>}
                {started(m) && m.state !== 'CANCELLED' && m.missed > 0 && (
                  <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-normal tabular-nums text-bad">{m.missed} missed</span>
                )}
              </>;
              const actions = (m: Meal) => expanded === m.id && editing !== m.id && (
                <div className="grid gap-3 border-t border-border pt-3">
                  {(m.policy_version === 100 || m.meal_type === 'PARON' || m.items.some((i) => i.alternatives.length)) && (
                    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                      {m.policy_version === 100 && <span>Test timings</span>}
                      {m.meal_type === 'PARON' && <ComingCount mealId={m.id} />}
                      {m.items.some((i) => i.alternatives.length) && (
                        <span>Choices close {m.choices_close_at ? `${dhakaDate(m.choices_close_at)}, ${timeRange(m.choices_close_at)}` : 'when the meal starts'}</span>
                      )}
                    </p>
                  )}
                  {/* One row: Close meal (only while it is being served), Edit, Delete. */}
                  <div className="flex gap-2">
                    {m.state === 'IN_SERVICE' && (
                      <ConfirmButton disabled={busy} className="!px-3 text-[clamp(0.8rem,3.8vw,1rem)] leading-tight"
                        onConfirm={() => act('Close', () => rpc('set_meal_service_state', { p_meal_service_id: m.id, p_target: 'CLOSED', p_reason: 'Closed by admin' }),
                          { OK: 'Meal closed.' })}>
                        Close meal
                      </ConfirmButton>
                    )}
                    <Button className="flex-1 !px-3 text-[clamp(0.8rem,3.8vw,1rem)]" onClick={() => setEditing(m.id)}>Edit</Button>
                    <ConfirmButton variant="danger" disabled={busy} className="!px-3 text-[clamp(0.8rem,3.8vw,1rem)] leading-tight"
                      onConfirm={() => act('Delete', () => rpc('delete_meal', { p_meal_service_id: m.id, p_confirm: 'DELETE' }),
                        { DELETED: 'Meal deleted.' })}>
                      Delete
                    </ConfirmButton>
                  </div>
                </div>
              );
              const ate = (m: Meal) => (started(m) && m.state !== 'CANCELLED' ? m.diners : undefined);
              const edited = g.find((m) => m.id === editing);
              return (
                <div key={g[0].id} id={g.length === 1 ? `meal-${g[0].id}` : undefined} className="scroll-mt-20">
                  {g.length > 1 ? (
                    <DayCard meals={g} when={g.every(past) ? 'past' : 'upcoming'} ate={ate}
                      selectedId={expanded} onSelect={select} aside={aside} extra={actions} />
                  ) : (
                    <MealCard plain when={past(g[0]) ? 'past' : 'upcoming'} selected={expanded === g[0].id}
                      meal={g[0]} onSelect={() => select(g[0])} aside={aside(g[0])} ate={ate(g[0])}>
                      {actions(g[0])}
                    </MealCard>
                  )}
                  {edited && (
                    <div className="card mt-2">
                      <MealEditor mode="edit" busy={busy} initial={formFor(edited)} onCancel={() => setEditing(null)}
                        onSubmit={async (f) => {
                          const m = edited;
                          const t = toTimestamps({ ...f, date: m.service_date, start: hhmm(m.service_start_at) });
                          const status = await act('Save', () => rpc('set_meal_details', {
                            p_meal_service_id: m.id, p_name: f.name, p_occasion: f.occasion, p_description: f.description,
                            p_end_at: t.end, p_items: itemsJson(f.items),
                          }));
                          if (status === 'OK') {
                            setEditing(null);
                            await saveExtras(m.id, f);
                          }
                        }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
      )}
    </>
  );
}
