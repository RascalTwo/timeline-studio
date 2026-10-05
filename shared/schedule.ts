// The scheduler and the migration ladder, in ONE place that both the page and the
// backend import.
//
// They lived only in index.html, which meant the two questions that matter most
// about a plan — "what does it land on" and "is this document current" — could
// only be answered by a browser. Anything else editing a plan (see AGENTS.md)
// could write a perfectly valid document and had no way to ask what it cost. The
// alternative was a second copy on the server, and a second copy of THIS file is
// the worst possible place to have one: `sched()` is the part of the tool that
// must be exactly right, because a chart that computes the wrong date tells a
// room something confidently false.
//
// `cal` is a required argument here, not a defaulted one. index.html keeps its
// `let CAL` and wraps each of these to restore the default its ~50 call sites
// rely on; a module has no page to read a global off, and making the caller say
// which calendar it means is the honest shape anyway.
//
// Plain .js, no TypeScript syntax: Bun imports it from api.ts and the browser
// imports it from index.html, and the static export inlines relative imports
// (viz/inline.ts), so the published single-file page carries it too.

// `Task` HERE IS THE SCHEDULER'S VIEW — day numbers — because nearly everything
// in this file runs after `dayNumbers()`. A stored task is `StoredTask`.
import type { DayTask as Task, Task as StoredTask, Doc, DocOf, DayDoc, Cal, Id, Starts, Milestone,
              ChannelValue, WhenField, Session } from "./types.js";
import { rankOf, suggestedRankOf } from "./commands.js";

// Node has had `structuredClone` as a global since 17 and every browser this
// ships to has it. Declared rather than pulling in the DOM lib, because this
// module runs on the server too and must not be able to reach `document`.
declare function structuredClone<T>(value: T): T;

export const DAY = 864e5;

// HOW LONG A TASK OCCUPIES THE CALENDAR, asked rather than assumed.
//
// `end = start + dur` was written out at eight sites, which was correct only
// while a duration and a calendar span were the same quantity. They are about to
// stop being: a duration is an amount of WORK and a span is an amount of TIME,
// and the moment a plan has non-working days in it the second is longer than the
// first. Every site that needs the end of a task goes through here, so there is
// one place to teach and no site that can be forgotten.
//
// A WORKING CALENDAR answers one question — does work happen on this day — out
// of two facts. `workweek` is a 7-slot mask indexed the way `getUTCDay()` counts
// (0 = Sunday), and `holidays` is a flat list of dates nobody works whatever the
// weekday says. One predicate, so no caller has to know there were two.
//
// The all-on calendar is not a special case in the code, it is the configuration
// a plan has when it has said nothing: a document with no `workweek` reads as
// this, and every duration in it keeps exactly the meaning it already had.
/** Every day is a working day — the calendar a document with no `workweek` has.
 *
 *  `isWorking` TAKES THE DAY AND IGNORES IT, rather than taking nothing. The
 *  argument is unused here and load-bearing everywhere else: this object and the
 *  one `makeCal` builds are used interchangeably (`makeCal` returns THIS one for
 *  a week with no working days), so a zero-arity signature here makes every
 *  `cal.isWorking(d)` in the page read as a call with one argument too many. It
 *  did — five of them, until 2026-09-05.
 *
 *  @type {{ isWorking: (day: number) => boolean, perWeek: number, allOn: boolean }} */
export const CAL_ALL = { isWorking: (_day: any) => true, perWeek: 7, allOn: true, from: 0, to: 1 };

// Day numbers, not dates: everything downstream of `dayOf` counts from the plan's
// own origin, so the calendar has to as well. `dow0` is the weekday that day 0
// lands on, which is the only thing a mask needs to line up with real weekdays.
//
// WORKING HOURS narrow each working day to one window, `from`–`to` as fractions of
// the day (ADR 0014). The default is the whole day, so a calendar built without
// them is the calendar every plan had before.
export function makeCal(mask: number[], offDays: number[], dow0: number, from = 0, to = 1) {
  const per = mask.reduce((a: any, b: any) => a + (b ? 1 : 0), 0);
  // A week with no working days makes spanOf walk forever — a hang, not an error.
  // The editor refuses to build one; this is the backstop for a hand-edited file.
  if (!per) return CAL_ALL;
  const off = new Set(offDays.map((d: number) => Math.floor(d)));
  return {
    isWorking: (d: number) => {
      const n = Math.floor(d);
      return !!mask[(((dow0 + n) % 7) + 7) % 7] && !off.has(n);
    },
    perWeek: per,
    allOn: per === 7 && !off.size,
    from, to,
  };
}

// TODAY is the real current date, NOT week 0. Those were the same thing while
// `start` was hardcoded to the day the plan was written; once the start date is
// editable they come apart, and a chart that labels its own left edge "today"
// while the date says otherwise is worse than one with no marker at all.
// The document's own working calendar. Holidays are stored as DATES because that
// is what anyone types and what survives moving the plan's start; they convert to
// day numbers here, at the one boundary that needs it, like every other date.
export function calOf(d: DocOf<unknown>) {
  if (!d) return CAL_ALL;
  // DAY NUMBERS FROM *THIS* DOCUMENT'S ORIGIN. This reached for the open plan's
  // `dayOf` before it moved here, which converted another document's holidays
  // against the wrong start date — invisible while the two always matched, and
  // wrong the moment the comparison lens or an archived version scheduled
  // something that had moved its start.
  const origin = Date.parse(d.start + "T00:00:00Z");
  const dayOf = (iso: string) => (Date.parse(iso + "T00:00:00Z") - origin) / DAY;
  // "HH:MM" wall clock in the plan's zone; `validateCommand` owns the format.
  const frac = (hm: string) => (+hm.slice(0, 2) * 60 + +hm.slice(3, 5)) / MINUTES_PER_DAY;
  const [from, to] = Array.isArray(d.workHours) ? d.workHours.map(frac) : [0, 1];
  const cal = makeCal(d.workweek || [1, 1, 1, 1, 1, 1, 1],
                      (d.holidays || []).map((iso: string) => dayOf(iso)),
                      new Date(d.start + "T00:00:00Z").getUTCDay(), from, to);
  // PLANNED STRETCHES RIDE ON THE CALENDAR, because every `spanOf`/`snapFwd`/`endOf` call site already carries one: a
  // stretch is a piece of the lane's working window that belongs to its task (see `plannedOf`), and it stays a claim on
  // the calendar until the task is done. Stored documents hold instants and the page holds day numbers, so both are read.
  const num = (v: any) => typeof v === "string" ? dayOfInstant(v, d) : v;
  const blocks: [number, number, Id][] = [];
  for (const t of (d.tasks || []) as any[])
    if (!t.done) for (const s of t.planned || []) blocks.push([num(s.start), num(s.stop), t.id]);
  blocks.sort((p, q) => p[0] - q[0]);
  return blocks.length ? { ...cal, blocks } : cal;
}

/** THE PLANNED STRETCHES OF A TASK NOBODY HAS STARTED, as day numbers: a promise that it happens exactly then (a meeting, a
 *  care-plan session), in wall-clock time whatever the working hours say. Sessions are what happened, `planned` is what is
 *  promised, in the same { start, stop } shape. Other work flows around a stretch (it is carved out of the lane's window,
 *  see `calOf`), and a task held by its plan does not queue. Null when there is nothing to hold: done, already worked on
 *  (the facts rule from its first session, and its remaining stretches still block everyone else), or no stretches. */
export const plannedOf = (t: any): { start: number; stop: number }[] | null =>
  !t.done && !t.sessions?.length && t.planned?.length ? t.planned : null;

// WHAT DAY IS IT, in the one place both sides can read. The page needs this to
// draw its TODAY line and the scheduler needs it to refuse a forecast that
// begins in the past; two definitions of "what day is it" is exactly the kind of
// duplicate this module exists to stop.
//
// IN THE PLAN'S ZONE, not the process's (v6). It used to be the process-local
// date, which made the page (browser, Central) and the server (container, UTC)
// disagree about "today" every evening. `doc.timeZone` is the one answer both
// read; without a doc, the default every pre-v6 plan was written in.
export const DEFAULT_TZ = "America/Chicago";
export const zoneOf = (d?: { timeZone?: string } | null) => (d && d.timeZone) || DEFAULT_TZ;

// THE WALL CLOCK OF AN INSTANT IN A ZONE, as milliseconds read as if UTC — the
// representation every day number here is built on. `Intl` is the only zone
// database JavaScript has, on both sides, so this is the one place it is asked.
const fmts = new Map<string, Intl.DateTimeFormat>();
const wall = (ms: number, tz: string) => {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }));
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(ms)) p[x.type] = +x.value;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + ((ms % 1000) + 1000) % 1000;
};
const originOf = (d: { start?: string }) => Date.parse(d.start + "T00:00:00Z");

/** An instant as a day number: calendar days since `doc.start` in the plan's
 *  zone, the fraction being that zone's wall clock. What the scheduler counts in. */
export const dayOfInstant = (iso: string, d: { start?: string; timeZone?: string }) =>
  (wall(Date.parse(iso), zoneOf(d)) - originOf(d)) / DAY;

/** The inverse: the instant whose wall clock in the plan's zone is day number
 *  `n`. Two refinement passes settle the zone offset, including across a DST
 *  change; a wall time a DST gap skips lands on the hour after it. Whole
 *  seconds, because nothing here is finer and a float that lands on :59.999
 *  would print as the minute before. */
export const instantOfDay = (n: number, d: { start?: string; timeZone?: string }) => {
  const tz = zoneOf(d), target = originOf(d) + n * DAY;
  let ms = target - (wall(target, tz) - target);
  ms = target - (wall(ms, tz) - ms);
  return new Date(Math.round(ms / 1000) * 1000).toISOString();
};

export const todayISO = (d?: { timeZone?: string } | null) =>
  new Date(wall(Date.now(), zoneOf(d))).toISOString().slice(0, 10);

// Today as a day number in THIS document's origin, which is the only unit
// `sched` speaks. Negative when the plan has not started yet, and that is the
// case that makes the floor below safe: a plan dated next month floors against a
// negative number, which `Math.max` discards, so it schedules exactly as it did.
export const todayOf = (d: { start?: string; timeZone?: string }) => d && d.start
  ? (Date.parse(todayISO(d) + "T00:00:00Z") - originOf(d)) / DAY
  : -Infinity;

/** Now, as a day number — `todayOf` plus the plan zone's wall clock. */
export const nowOf = (d: { start?: string; timeZone?: string }) => dayOfInstant(new Date().toISOString(), d);

/** EVERY INPUT THAT CAN CHANGE WHAT THE REORDER SEARCH FINDS, as one string:
 *  two documents with the same signature have the same best queue order. The
 *  page uses it to mark its Order advice stale, and the server's Auto-order to
 *  decide whether a change needs a search at all — so a rename or a new
 *  description costs nothing. Task ARRAY order is in it (the map preserves it),
 *  which is what a queue move changes; so is `autoOrder`, so switching it on
 *  counts as a change. */
export const orderSignature = (d: any) => !d ? "" : JSON.stringify([d.start, d.timeZone, d.workweek, d.holidays, d.workHours,
  d.autoOrder === true, (d.lanes || []).map((l: any) => [l.id, l.cap]),
  (d.milestones || []).map((m: any) => [m.id, m.date]),
  (d.tasks || []).map((t: any) => [t.id, t.lane, t.dur, t.ms, t.deps, t.due,
                                   t.noQueue, t.notBefore, t.done, t.sessions, t.planned]),
  // THE RANKING'S ANSWERS: an answer can make a tie-break move worth taking, so answering
  // re-settles the queue rather than waiting for the next date-related edit.
  d.rankLog,
  // AN UNADOPTED SUGGESTION steers too (unless switched off), so its arrival, its order and the
  // switch each re-settle the queue.
  d.rankSuggestion?.order, d.useRankSuggestion]);

export const WHEN_FIELDS: readonly WhenField[] = ["notBefore", "refinedAt", "due"];

/** WHEN WORK REALLY BEGAN AND ENDED, read off the sessions — schema v8 stores nothing else (ADR 0016): the first
 *  start, and for a done task the last stop. Instants. The scheduler reads them as `actualStart`/`actualEnd` day
 *  numbers, projected by `dayNumbers` and by the page's guard; neither is ever stored or sent. */
export const actualsOf = (t: { sessions?: Session[] | null; done?: boolean }) => {
  const ss = t.sessions;
  if (!Array.isArray(ss) || !ss.length) return { actualStart: undefined, actualEnd: undefined };
  return { actualStart: ss[0]!.start, actualEnd: t.done ? ss[ss.length - 1]!.stop ?? undefined : undefined };
};

/** WHERE A TASK IS: done (the flag), running (a session open), paused (worked on, none open), or not started. */
export const statusOf = (t: { sessions?: Session[] | null; done?: boolean } | Task): "todo" | "running" | "paused" | "done" =>
  t.done ? "done" : !t.sessions?.length ? "todo" : t.sessions.some((s: Session) => s.stop === null) ? "running" : "paused";

/** A STORED DOCUMENT AS THE SCHEDULER READS IT: every `WhenField` projected
 *  from an instant to a day number in the plan's zone, and `dur` from whole
 *  minutes to days (v7). The one door between the two representations —
 *  anything that does arithmetic on a task's times goes through here first. */
export const MINUTES_PER_DAY = 1440;
/** WORKED-ON AND NOT FINISHED: `worked` is the WALL-CLOCK time already spent, in days, and `resume` the
 *  floor the rest is forecast from (now). `dur` stays the estimate; `spanOf` subtracts. A running session
 *  counts up to `now`. One function because two readers need it: `dayNumbers`, and the page's guard, which
 *  projects a stored task to day numbers itself and never calls `dayNumbers`. */
export const workedOn = (t: StoredTask, d: Doc, now: number) => {
  if (t.done || !Array.isArray(t.sessions) || !t.sessions.length) return null;
  return { resume: now, worked: t.sessions.reduce((m: number, s: any) => m + (s.stop != null
    ? (Date.parse(s.stop) - Date.parse(s.start)) / 864e5 : Math.max(0, now - dayOfInstant(s.start, d))), 0) };
};
export const dayNumbers = (d: Doc, now = nowOf(d)): DayDoc => ({ ...d, tasks: (d.tasks || []).map((t: StoredTask) => {
  const o: any = { ...t };
  for (const k of WHEN_FIELDS) if (typeof o[k] === "string") o[k] = dayOfInstant(o[k], d);
  const a = actualsOf(t);
  if (a.actualStart != null) o.actualStart = dayOfInstant(a.actualStart, d);
  if (a.actualEnd != null) o.actualEnd = dayOfInstant(a.actualEnd, d);
  if (t.planned?.length) o.planned = t.planned.map((s: any) => ({ start: dayOfInstant(s.start, d), stop: dayOfInstant(s.stop, d) }));
  if (typeof o.dur === "number") o.dur = o.dur / MINUTES_PER_DAY;
  const w = workedOn(t, d, now);
  if (w) { o.worked = w.worked; o.resume = w.resume; }
  return o;
}) });

/** A v6 duration in days as v7's whole minutes. Exact minutes are kept; anything
 *  else was a decimal guess (`0.03` days is 43.2 minutes) and rounds to the
 *  nearest five, never below five — zero is not a duration. */
export const minutesOf = (days: number) => {
  const m = days * MINUTES_PER_DAY, whole = Math.round(m);
  return Math.abs(m - whole) < 1e-6 ? Math.max(1, whole) : Math.max(5, Math.round(m / 5) * 5);
};

// HOW LONG A TASK OCCUPIES THE CALENDAR. `dur` is an amount of WORK, and this
// walks forward handing that work to the days that will take it. A day it cannot
// use costs time and consumes nothing, which is the whole difference between the
// two units.
//
// Fractions survive: a remainder lands INSIDE the final working day rather than
// rounding up to it, which is what keeps `dur: 0.5` meaning half a day of work
// instead of a whole one. The reference plan carries a fractional duration on
// purpose and this is the function that has to keep it honest.
/** WHAT IS LEFT OF A TASK'S ESTIMATE, in days: the whole `dur`, or for a task being worked on (see
 *  `dayNumbers`) `dur` minus the wall-clock time already worked, never under a minute so an overrun task
 *  stays a bar you can click. What the forecast spends, and what load totals should add up. */
export const remainingOf = (t: Task) => t.resume != null ? Math.max(1 / MINUTES_PER_DAY, t.dur - (t.worked || 0)) : t.dur;

/** The parts of [a, b] no planned slot covers, in order; `own` is the task asking, whose own slot is not in its way. */
const freeIn = (a: number, b: number, blocks: [number, number, Id][], own: Id) => {
  const out: [number, number][] = [];
  let pos = a;
  for (const [x, y, id] of blocks) {
    if (id === own || y <= pos || x >= b) continue;
    if (x > pos) out.push([pos, x]);
    pos = Math.max(pos, y);
  }
  if (b > pos) out.push([pos, b]);
  return out;
};

export function spanOf(t: Task, start: number, cal: Cal) {
  // A FACT BEATS A WALK. Once we know when a task really finished, the calendar
  // has no say in how long it took — the observed span is the answer, and `dur`
  // stays in the document as the estimate that turned out to be wrong, which is
  // worth keeping and is no longer what drives the bar.
  //
  // BOTH dates, not either. With only a start, the task is in progress and the
  // estimate is still the best thing anyone has, so the walk below runs from the
  // real start — which is the honest reading, not a special case.
  // NEVER NEGATIVE: a negative span would land `endOf` before the task began, so
  // a dependent would be scheduled before its predecessor started. Sessions are
  // in order by rule, so the last stop is never before the first start; a task
  // finished without being started is one session of no length, and spans none.
  if (t.actualStart != null && t.actualEnd != null && t.actualEnd >= t.actualStart)
    return t.actualEnd - t.actualStart;
  // A PLANNED TASK IS WALL CLOCK, from its first stretch's start to its last one's end: 4:30 to 6:30pm is two hours however the
  // window closes. Only when it is being drawn AT that start: `sched` places it elsewhere once the plan has lapsed (see below),
  // and then it is ordinary work again.
  const pl = plannedOf(t);
  if (pl && Math.abs(start - pl[0]!.start) < 1e-9) return pl[pl.length - 1]!.stop - start;
  let need = remainingOf(t);
  if (!(need > 0)) return 0;
  // Only the day's window takes work, so time before it is skipped as well as
  // time after it. That is also what makes a REAL start off-hours burn nothing
  // until the window opens — the same thing a real start on a Saturday already
  // did (ADR 0014: an optimistic forecast is the worse error).
  const from = cal.from ?? 0, to = cal.to ?? 1;
  // A task being worked on is forecast from now, not from when it began (`resume`, see `dayNumbers`).
  const from0 = t.resume != null ? Math.max(start, t.resume) : start;
  let d = Math.floor(from0), pos = from0, guard = 0;
  // Spends the work available in [fa, fb]: returns where it ends, or null if it needs more.
  const take = (fa: number, fb: number) => {
    const avail = fb - fa;
    if (!(avail > 0)) return null;
    if (avail >= need - 1e-9) return fa + need;
    need -= avail;
    return null;
  };
  while (need > 1e-9) {
    if (++guard > 1e5) break;                    // cannot happen: makeCal refuses an empty week
    if (cal.isWorking(d)) {
      const a = Math.max(pos, d + from), b = d + to;   // working time left in this day, less the planned slots on it
      let end: number | null = null;
      if (!cal.blocks) end = take(a, b);
      else for (const [fa, fb] of freeIn(a, b, cal.blocks, t.id)) if ((end = take(fa, fb)) != null) break;
      if (end != null) return end - start;
    }
    d += 1; pos = d;
  }
  return pos - start;
}

export function endOf(t: Task, start: number, cal: Cal) { return start + spanOf(t, start, cal); }

/** HOW MUCH WORKING TIME A STRETCH HOLDS, in days: the part of each working day inside its window (ADR 0014), less every
 *  planned slot but `own`'s — the time `spanOf` walks around. Its inverse, so a span holds exactly its duration: the page's
 *  audit asserts that, and the grip drag turns a width back into work with it. */
export function workDaysIn(start: number, span: number, cal: Cal, own: Id = "") {
  const from = cal.from ?? 0, to = cal.to ?? 1;
  let n = 0;
  for (let d = Math.floor(start); d < start + span - 1e-9; d += 1) {
    if (!cal.isWorking(d)) continue;
    const a = Math.max(start, d + from), b = Math.min(start + span, d + to);
    if (b > a) for (const [x, y] of cal.blocks ? freeIn(a, b, cal.blocks, own) : [[a, b]]) n += y! - x!;
  }
  return Math.round(n * 1e6) / 1e6;
}

/** THE STRETCHES OF [a, b] WHERE NO WORK HAPPENS: outside the day's window, and every non-working day,
 *  merged so a night or a weekend is one gap. `spanOf` spends work only inside the window (ADR 0014), so a
 *  forecast bar should not be drawn across these. */
export function offHours(a: number, b: number, cal: Cal, own?: Id): [number, number][] {
  const from = cal.from ?? 0, to = cal.to ?? 1, out: [number, number][] = [];
  const add = (x: number, y: number) => {
    x = Math.max(x, a); y = Math.min(y, b);
    if (!(y - x > 1e-9)) return;
    const last = out[out.length - 1];
    if (last && x - last[1] < 1e-9) last[1] = y; else out.push([x, y]);
  };
  for (let d = Math.floor(a); d < b; d++) {
    if (cal.isWorking(d)) { add(d, d + from); add(d + to, d + 1); } else add(d, d + 1);
  }
  // Planned slots (other than `own`) are gaps for everyone else's work too.
  if (!cal.blocks) return out;
  const all = [...out];
  for (const [x, y, id] of cal.blocks) if (id !== own && y > a && x < b) all.push([Math.max(x, a), Math.min(y, b)]);
  all.sort((p, q) => p[0] - q[0]);
  const merged: [number, number][] = [];
  for (const g of all) { const l = merged[merged.length - 1]; if (l && g[0] - l[1] < 1e-9) l[1] = Math.max(l[1], g[1]); else merged.push([g[0], g[1]]); }
  return merged;
}

/** The complement of `offHours`: where work can happen inside [a, b]. A task that crosses a night is two
 *  chunks, the second starting when the window reopens. */
export function workChunks(a: number, b: number, cal: Cal, own?: Id): [number, number][] {
  const out: [number, number][] = []; let pos = a;
  for (const [g0, g1] of offHours(a, b, cal, own)) { if (g0 - pos > 1e-9) out.push([pos, g0]); pos = g1; }
  if (b - pos > 1e-9) out.push([pos, b]);
  return out;
}

// A task cannot BEGIN on a day nobody works — the bar's left edge would mark a
// date on which nothing happens. Note it moves a whole day and leaves a start
// that is already mid-working-day alone, so on an all-on calendar it is the
// identity and every existing plan schedules exactly as it did.
// Working hours make the same rule hold inside a day: before the window snaps to
// its opening, after it to the next working day's.
export function snapFwd(d: number, cal: Cal): number {
  const from = cal.from ?? 0, to = cal.to ?? 1;
  let x = Math.floor(d), guard = 0;
  // `- 1e-9`: a dependency ending exactly at closing time hands over a start of
  // 17:00 give or take a float, and that is tomorrow's opening, not today's close.
  if (cal.isWorking(x) && d - x < to - 1e-9) {
    const p = Math.max(d, x + from), k = cal.blocks?.find(([a, b]) => p >= a - 1e-9 && p < b - 1e-9);   // not inside a planned slot
    return k ? snapFwd(k[1], cal) : p;
  }
  do { x += 1; if (++guard > 3660) return d; } while (!cal.isWorking(x));
  return x + from;
}

// ---------------------------------------------------------------------------
// SCHEDULER.
//
// This is the load-bearing part of the tool and the only part that must be
// exactly right: a chart that computes the wrong date tells a room something
// confidently false, which is worse than having no chart. It began as a port of
// a Python model that produced the original static charts; that script is not in
// this repo and is no longer the reference. `selftest()` at the bottom schedules
// a hardcoded reference plan and shouts in the page if its answer drifts.
//
// Semantics worth preserving deliberately:
//  - Every lane is a SINGLE serial queue (capacity 1). That is the constraint
//    the whole plan turns on -- servers are built one at a time -- so it is not
//    a simplification, it is the model.
//  - Ties break by task order in the file (`est < best-1e-9`, strictly less), so
//    the array order in the JSON is meaningful. Do not sort tasks for display
//    before scheduling; render order is derived from the result instead.
// ---------------------------------------------------------------------------
// LANE CAPACITY: how many things a team can have in flight at once. Defaults to
// 1, which is what every lane was hardcoded to before — a team as a single serial
// queue. `cap: 2` on a lane means two tasks can run side by side, and the
// scheduler puts each new task in whichever of that lane's slots frees up first.
//
// This is the resource half of resource-constrained scheduling. Without it the
// only way to say "the server team could do two at a time" was to not model the
// team at all, which also throws away the queueing that makes the chart honest.
//
// `lanes` is a parameter rather than read off `doc` so the self-test can schedule
// its reference plan without the loaded document's capacities leaking into it.
//
// START CONSTRAINTS: an optional `notBefore` (week number, same units and same
// origin as everything else) is a floor on when a task may start — MS Project
// calls it Start No Earlier Than, the scheduling literature calls it a release
// date. It is an INPUT to the scheduler, exactly like a dependency, which is the
// whole reason it exists in this shape: a dragged x-coordinate would have to be
// stored, and a stored coordinate does not survive a reflow. A constraint does.
// Every reschedule honours it for free, and it participates in the critical
// path, in float and in milestone pass/fail without another line anywhere.
//
// It can only ever push a task LATER, never earlier, so it cannot make a plan
// unschedulable — that is why SNET is the benign member of the constraint
// family, and why the ALAP shift in renderInner() needs no changes: the shift is
// non-negative, so a bar can never render to the left of its own constraint.
//
// TODAY IS A FLOOR ON EVERY FORECAST, and it is the term that was missing for as
// long as this file has existed. Without it `sched` answers "earliest feasible
// start" from day 0 and day 0 never moves, so a task with no predecessors keeps
// claiming the plan's start date however long ago that was — nine of them were
// claiming three days of progress nobody had recorded, and every dependent
// inherited the head start, which made the finish date and every milestone chip
// optimistic by the same three days. The plan was not a forecast, it was a
// forecast AS OF the day it was written, presented as current.
//
// A forecast that has not started cannot have started in the past. That is the
// whole rule. Work that really did begin is seeded above and never reaches this
// loop, so a fact is never moved by the clock — only a guess is, and a guess
// about the past is not a guess, it is a lie the chart tells a room.
//
// A PARAMETER, defaulting to no floor at all, for the same reason `lanes` and
// `cal` are parameters: the self-test schedules hardcoded reference plans whose
// answers must not change because a day passed. A wall clock reaching into this
// function implicitly is how a test starts failing overnight for no reason.
// WORK THAT DOES NOT OCCUPY THE TEAM. `noQueue: true` on a task takes it out of
// its lane's queue: it neither waits for a slot nor holds one afterwards. The
// lane still OWNS it — raising an access request is developer work and belongs
// under Developers — but the queue is a claim about capacity, and filling in nine
// request forms is not nine turns at the one thing the team can do at a time.
//
// BOTH HALVES ARE THE FEATURE, and either alone is a bug. Ignoring the slot but
// still claiming one lets nine exempt tasks serialise a lane for everybody else;
// releasing the slot but still waiting for one leaves them queued behind the very
// work they are not competing with.
//
// It is deliberately NOT a lane with a big capacity, which is the workaround it
// replaces. Moving these tasks to an "easy things" lane would put them under a
// team that does not exist, and lanes are teams — the plan would stop saying who
// does the work in order to say how the work is shaped.
//
// It is also not `cap` on the lane: a lane where SOME tasks queue and others do
// not cannot be expressed by one number, and raising the whole lane's capacity to
// cover the cheap tasks silently tells the same lie about the expensive ones.
/** Does this dependency graph contain a cycle?
 *
 *  A GRAPH QUESTION, ASKED OF THE GRAPH. The page used to answer it by running
 *  `sched` on a trial document and catching the throw, which is not the same
 *  question: `sched` throws when it cannot PLACE everything, and a cycle whose
 *  members are already placed never stops it. A task with an `actualStart` is
 *  seeded straight into the schedule and never enters the loop, so a cycle
 *  running through anything already started — or through a dropped task, whose
 *  edges `scheduleView` cuts — was accepted, saved and broadcast. Measured on a
 *  real plan: a three-task cycle through one finished task, and the chart went
 *  on drawing as if nothing were wrong.
 *
 *  Iterative rather than recursive, for the reason `hopsUp` is: a cycle is
 *  exactly the input that blows a recursive walk's stack, and this runs on
 *  documents that may already contain one.
 *
 *  Reads `deps` as given. It does NOT go through `scheduleView` — the point is
 *  to catch a cycle the schedule is currently hiding. */
export function hasCycle(tasks: { id: Id; deps: Id[] }[]): boolean {
  const by = Object.fromEntries(tasks.map((t: Task) => [t.id, t]));
  // 0 = unvisited, 1 = on the current path, 2 = done and clean.
  const mark: Record<Id, number> = {};
  for (const root of tasks) {
    if (mark[root.id]) continue;
    const stack: { id: Id; i: number }[] = [{ id: root.id, i: 0 }];
    mark[root.id] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const deps = by[top.id]?.deps || [];
      if (top.i >= deps.length) { mark[top.id] = 2; stack.pop(); continue; }
      const next = deps[top.i++]!;
      // A dep naming a task that is not here is a different fault, and
      // `invalid()` already refuses it. Not a cycle.
      if (!by[next]) continue;
      if (mark[next] === 1) return true;
      if (!mark[next]) { mark[next] = 1; stack.push({ id: next, i: 0 }); }
    }
  }
  return false;
}

/** The task list AS THE SCHEDULER SEES IT: abandoned work costs nothing, holds no
 *  lane slot and blocks nobody, and everything else loses its edges to it.
 *
 *  EXPORTED BECAUSE THE AUDIT HAS TO ASK THE SAME QUESTION. The page re-derives
 *  the schedule's own rules from the document to check `sched` against them, and
 *  a rewrite that lived inside `sched` made the auditor disagree with the thing
 *  it audits the moment anything was dropped — it read the original duration and
 *  the original edges, then reported a dependency violation and a lane over
 *  capacity against a schedule that was exactly right. Two definitions of "what
 *  is actually being scheduled" is the drift this module exists to prevent.
 *
 *  DROPPED TASKS ARE REWRITTEN, NOT REMOVED. `sched` must return a start for
 *  every task it is given: the page reads starts by id at 22 sites, and a
 *  missing one becomes NaN in the layout arithmetic and hangs the column walk.
 *
 *  Copies throughout — this runs against the live document on every keystroke,
 *  and editing `deps` in place would make dropping a task silently delete
 *  dependencies that should come back the moment it is undropped. */
//
// NOTHING READS `dropped` ANY MORE (2026-09-20). A guard lived here for an hour
// so that restoring a pre-cutover version could not resurrect abandoned work as
// live rows; it is gone with the rest of the concept. The consequence, written
// down so it is not a surprise: restore a version saved before the cutover and
// any task that was cancelled in it comes back as ordinary work. Two of them
// exist in this author's archive and deleting them again is two clicks — which
// is a better trade than three lines of code nothing else in the system knows
// about, kept forever against a rare action.
export function scheduleView(tasks: Task[]): Task[] {
  const touched = (t: Task) => !t.noQueue && !(t.dur > 0);
  if (!tasks.some(touched)) return tasks;
  return tasks.map((t: Task) =>
    // WORK THAT TAKES NO TIME DOES NOT QUEUE FOR A SLOT. A lane's capacity
    // rations working time, and a zero-duration task consumes none of it —
    // making it wait for a free slot says "I can only do one instantaneous
    // thing at a time", which is technically true and useless. On a personal
    // plan, where most tasks have no meaningful duration, it was the difference
    // between a deadline reading "misses by 4 days" and "misses by 11": the
    // task was not late, it was queued behind a fortnight of unrelated work it
    // did not need to wait for.
    //
    // REFUSED AT THE DOOR AGAIN AS OF 2026-09-20, and this stays anyway. `dur: 0`
    // was refused by validation until the personal fields landed, was legal for
    // a day, and is refused again now — but only by the COMMAND validators, so
    // that the fifty-odd archived versions written while it was legal remain
    // revertable, forkable and comparable. Those documents are what this branch
    // is for now. A plan being edited today cannot reach it.
    // The edge-cutting that used to live here went with `dropped`: it existed to
    // stop a dependent waiting on work nobody would ever do, and there is no
    // longer a way to mark work that way.
    !t.noQueue && !(t.dur > 0) ? { ...t, noQueue: true } : t);
}

const NO_DEPS: Id[] = [];

// `today` is the FLOOR a forecast may not start before; `now` is the instant
// that recorded work may not claim the lane beyond. Omitted, nothing is capped —
// the self-test and the fixed reference plans schedule exactly as they did.
//
// FORECASTS START NOW. Every caller passes now as the floor (2026-09-27). It was
// midnight today, which with working hours snapped to 8am — so at 4pm unstarted
// work was forecast into the morning that had already gone, and a 2h task due at
// 5pm read "7 hrs to spare". A floor after hours snaps to the next opening, and
// work that doesn't fit today's window continues in tomorrow's.
export function sched(tasks: Task[], lanes: ChannelValue[], cal: Cal, today = -Infinity, now = Infinity) {
  // DROPPED WORK COSTS NOTHING AND BLOCKS NOTHING — but it is still PLACED, and
  // that last part is the whole subtlety. `sched` returning a start for every
  // task it was given is an invariant with 22 call sites in the page: a missing
  // start arrives as `undefined`, turns into NaN in the layout arithmetic, and
  // the column walk that consumes it never terminates. Dropping one task froze
  // the browser outright.
  //
  // So abandoning work is expressed in the three fields that already mean
  // "takes no time, holds no slot, waits for nobody" rather than by removing the
  // row. Its dependents lose the edge for the same reason — the loop advances a
  // task only when every dep is already placed, and a dropped blocker would
  // otherwise hold its whole downstream forever.
  //
  // On COPIES. `sched` runs against the live document on every keystroke, and
  // editing `deps` in place would make dropping a task silently delete
  // dependencies that ought to come back the moment it is undropped.
  tasks = scheduleView(tasks);
  const by = Object.fromEntries(tasks.map((t: Task) => [t.id, t]));
  const capOf = (l: Id) => Math.max(1, Math.floor((lanes.find((x: ChannelValue) => x.id === l) || {}).cap || 1));
  const ids = [...new Set(tasks.map((t: Task) => t.lane))];
  const start: Starts = {}, slots: Record<Id, number[]> = Object.fromEntries(ids.map(l => [l, Array(capOf(l)).fill(0)]));
  // WHO is in each slot, not just until when. "That lane is busy" answers the
  // question one level short of useful: the next thing anyone asks is "busy with
  // WHAT", and the queue is the one bottleneck with no arrow on the chart
  // pointing at its cause. Tracked here because this is the only place it is
  // known — a lane's occupant leaves no trace in `start`.
  const owner: Record<Id, unknown[]> =
    Object.fromEntries(ids.map(l => [l, Array(capOf(l)).fill(null)]));
  // Declared up here rather than beside the loop because the seeding pass below
  // also answers "why is it there", and answering for only the tasks the LOOP
  // placed is how a started task ends up explaining nothing at all.
  const why: Record<Id, string> = {}, whyGap: Record<Id, number> = {},
        whyWho: Record<Id, unknown> = {};
  // SEEDED, NOT SOLVED FOR. An actual start is a stronger input than every other
  // one here: `notBefore` is a floor and appears below as one term in a
  // `Math.max`, so a dependency or a busy lane can push a task past it. This
  // says EXACTLY HERE, and it overrides the dependency arithmetic and the lane
  // queue rather than joining them — there is nothing to solve for, so the loop
  // never considers these tasks at all.
  //
  // AND IT IS NOT SNAPPED. `snapFwd` exists because a forecast cannot begin on a
  // day nobody works; work that really did start on a Saturday did, and moving
  // it to the Monday would be inventing a date. Forecasts get snapped, facts do
  // not.
  //
  // The lane still fills up, because the team was still busy. `Math.max` rather
  // than assignment: two pinned tasks can share a slot the capacity says holds
  // one, and the second must not pull the lane's busy-until backwards.
  for (const x of tasks) {
    // A PLANNED TASK IS SEEDED TOO, at its first stretch's start: it is a promise about the calendar, not a request the queue
    // can answer later. It never holds a lane slot; the stretches are carved out of the window (see `calOf`). Once its last
    // stretch is over without anyone starting it the promise has lapsed, and it goes through the loop like any forecast.
    const pl = plannedOf(x), planned = !!pl && pl[pl.length - 1]!.stop > today;
    // PAUSED WORK IS NOT HAPPENING, so it is not seeded (ADR 0018): what is left of it goes back in the queue below like
    // any forecast, in its row's place. Seeding it here forecast every paused task from now at once, beside the one
    // really running, and a lane of one ran four. Only running work, and finished work, are facts about the lane.
    if ((x.actualStart == null || statusOf(x) === "paused") && !planned) continue;
    start[x.id] = planned ? pl![0]!.start : x.actualStart!;
    // A FACT IS ITS OWN REASON. These tasks never enter the loop, so without this
    // they have no entry at all and the inspector says nothing about them — which
    // is exactly what it did for the two dev servers the moment someone recorded
    // when they really started.
    why[x.id] = planned ? "slot" : "actual";
    // WORK THAT DOES NOT QUEUE DOES NOT QUEUE ONCE IT HAS STARTED EITHER. This
    // loop filled the lane for every task with actuals, `noQueue` or not, so an
    // agent's own exempt task held its human's lane the moment it recorded a
    // start — the flag's whole meaning, ignored for exactly the tasks in progress.
    if (x.noQueue || planned) continue;
    const k = slots[x.lane].indexOf(Math.min(...slots[x.lane]));
    // FINISHED WORK FREES THE LANE WHEN IT FINISHED, and never later than now:
    // a record claiming the future (the whole-day ends pre-v6 wrote, "until
    // midnight") must not keep a lane busy with work that is already done.
    // Work still in progress keeps its estimated end — it is still going.
    const end_ = x.actualEnd != null
      ? Math.min(endOf(x, x.actualStart!, cal), Math.max(now, x.actualStart!))
      : endOf(x, x.actualStart!, cal);
    // Only when it actually extends the slot: `Math.max` can keep the earlier
    // value, and the occupant is then still whoever set that.
    if (end_ > slots[x.lane][k]) { slots[x.lane][k] = end_; owner[x.lane][k] = x.id; }
  }
  // WHY LIVES ON THE RESULT, NOT IN A GLOBAL, and that was not a tidiness choice.
  // `sched` runs for the live document, for an archived version behind the
  // comparison, and three times in the self-test against a hardcoded reference
  // plan; with a global, last writer wins — and selftest() runs at boot AFTER the
  // first render, so the first task anyone clicked was explained using the
  // reference plan's queue. Hanging it off the returned map makes the answer and
  // the schedule it describes the same object, impossible to get out of step.
  // WHEN EACH PLACED TASK ENDS, WORKED OUT ONCE. `endOf` walks the calendar a day
  // at a time for the whole of a task's duration — a 20-day task on a five-day
  // week is 28 steps — and this loop was calling it for every dependency of every
  // UNPLACED candidate, on every one of its n iterations. That is
  // O(n² · deps · duration) calendar steps to answer a question whose answer
  // cannot change: a task's start is fixed the moment it is placed, so its end is
  // too.
  //
  // Measured on a plan with this one's shape it is the dominant cost of `sched`,
  // and `sched` is the dominant cost of a reorder search — which runs ~2,900 of
  // them. Nothing about the ANSWER changes; this is the same number, remembered.
  const endCache: Record<Id, number> = {};
  const endAt = (id: Id) => endCache[id] ?? (endCache[id] = endOf(by[id], start[id], cal));

  let guard = tasks.length + 1;
  // COUNTED, NOT RECOUNTED. This asked `Object.keys(start).length` — which builds
  // an array of every id placed so far — once per iteration of a loop that runs
  // once per task. That is an n-element allocation n times, an accidental O(n²)
  // sitting on top of the selection the loop is actually doing, and it is paid by
  // every schedule in the tool: every render, every /verdict, and every one of the
  // ~2900 schedules a reorder search runs on a 135-task plan.
  //
  // SEEDED FROM `start`, NOT FROM ZERO, and getting that wrong is not subtle: an
  // ACTUAL start is placed before this loop begins (see "SEEDED, NOT SOLVED FOR"
  // above), so counting only the loop's own placements leaves it looking for
  // tasks that are already scheduled — it runs past the guard and throws
  // "dependency cycle" on a plan that has none. Caught immediately by
  // docs/original/verify.sched.mjs, which is what that file is for.
  let placed = Object.keys(start).length;
  // ONLY THE UNPLACED ARE SCANNED. Each round looked at every task and skipped the
  // placed ones, so a plan that is mostly finished paid for its history on every
  // placement. Same order, so a tie still goes to the earlier row.
  const open = tasks.filter((t: Task) => !(t.id in start));
  while (placed < tasks.length) {
    if (guard-- < 0) throw new Error("dependency cycle");
    // SCALARS, NOT A TUPLE, and one pass over `deps` instead of two.
    //
    // This inner loop runs once per unplaced task per placement — ~18,000 times
    // for a 135-task plan — and it was allocating on every one of them: a tuple
    // for `best`, an array from `deps.map`, and two argument spreads. Profiling a
    // real plan put the cost here and NOT where it was assumed to be: durations on
    // a real plan are short (median 2 days), so the calendar walk inside `endOf`
    // is only ~20k steps for a whole schedule and is not the hot part. The
    // allocations were.
    //
    // Every value below is the same value it was; only the way it is reached
    // changed. `Math.max(0, ...[])` is 0, which is what `dep` starts at.
    let bEst = 0, bDep = 0, bLane = 0, bRaw = 0, bWho: unknown = null;
    let bx: Task | null = null, bi = -1;
    for (let i = 0; i < open.length; i++) {
      const x = open[i]!;
      if (x.id in start) continue;
      let dep = 0, ready = true;
      // A paused task (the only kind here with `resume`) already started, which overrode what it waits on; re-queuing
      // its remainder must not take that back.
      for (const d of x.resume != null ? NO_DEPS : x.deps) {
        if (!(d in start)) { ready = false; break; }
        const e = endAt(d);
        if (e > dep) dep = e;
      }
      if (!ready) continue;
      // SNAP INSIDE `est`, NOT AFTER THE WINNER IS PICKED. The loop's contract is
      // the earliest FEASIBLE start, and a non-working day is not feasible — so
      // choosing on the unsnapped number chooses on a date the task cannot have,
      // and lets a Saturday candidate beat a Sunday one on a difference that
      // disappears the moment both land on Monday.
      // An exempt task reads the queue as always-free rather than skipping the
      // term: `0` keeps it in the same `Math.max` as everything else, so the
      // `why` reporting below still compares like with like and can never
      // conclude "held by the lane" for a task that does not queue.
      // The free slot, and WHICH slot it is, from one scan rather than a spread
      // followed by an `indexOf` that scans again to find what it just computed.
      let lane = 0, slotK = 0;
      if (!x.noQueue) {
        const sl = slots[x.lane];
        lane = sl[0]!; slotK = 0;
        for (let k = 1; k < sl.length; k++) if (sl[k]! < lane) { lane = sl[k]!; slotK = k; }
      }
      const raw = dep > (x.notBefore || 0) ? dep : (x.notBefore || 0);
      const raw2 = raw > lane ? raw : lane;
      // A paused remainder is forecast from `resume` (now) at the earliest, whatever floor the caller passed.
      const fl = x.resume != null && x.resume > today ? x.resume : today;
      const rawT = raw2 > fl ? raw2 : fl;
      const est = snapFwd(rawT, cal);
      if (!bx || est < bEst - 1e-9) {
        bEst = est; bx = x; bi = i; bDep = dep; bLane = lane; bRaw = rawT;
        // EXACTLY WHAT IT WAS. The original read
        // `owner[lane][slots[lane].indexOf(lane_)]`, and for an exempt task
        // `lane_` is the literal 0 it was given rather than a slot value — so the
        // indexOf found nothing and this was `undefined`. It is discarded either
        // way (`why` can never say "lane" for a task that does not queue), and
        // "the value is thrown away" is not a good enough reason to change it in
        // this file.
        bWho = x.noQueue ? undefined : owner[x.lane][slotK];
      }
    }
    if (!bx) throw new Error("dependency cycle");
    const est = bEst, x = bx, dep_ = bDep, lane_ = bLane, raw_ = bRaw, who_ = bWho;
    start[x.id] = est;
    open.splice(bi, 1);
    placed++;
    // WHY IT LANDED THERE, recorded rather than reconstructed. Every input to the
    // decision is in hand at exactly this line and nowhere else afterwards, so
    // working it out again later would mean a second copy of the lane simulation
    // — the one thing `start` cannot be reverse-engineered into, because a queue
    // position leaves no trace in the document. Three values, once per task.
    //
    // Ties resolve to the FIRST of dependency / constraint / queue, because that
    // is the order a person asks: "what am I waiting on" before "is my team
    // busy". The per-dependency slack below shows a tie for what it is anyway —
    // more than one chip reading zero.
    //
    // `today` sorts LAST, below even the queue, because it is the weakest thing
    // that can hold a task: it names the absence of a cause rather than a cause.
    // A task whose dependency happens to end today is held by that dependency
    // and should say so — "today" is the answer only when nothing in the plan
    // wanted this task later and the calendar alone moved it. It is also the one
    // reason that would otherwise report as `free`, which is the same lie in a
    // smaller place: "nothing is holding me, and I began three days ago".
    why[x.id] = raw_ < 1e-9 ? "free"
      : dep_ >= raw_ - 1e-9 ? "deps"
      : (x.notBefore || 0) >= raw_ - 1e-9 ? "notBefore"
      : lane_ >= raw_ - 1e-9 ? "lane" : "today";
    // Snapping can push a task past the constraint that chose it — onto the next
    // working day — which is the case that otherwise reads as "nothing is holding
    // me and I am still late".
    if (est > raw_ + 1e-9) whyGap[x.id] = est - raw_;
    if (why[x.id] === "lane" && who_) whyWho[x.id] = who_;
    // The other half: an exempt task does not hold a slot either, so it cannot
    // push the work that DOES queue later. Without this the exemption only moves
    // the pile-up one task down.
    if (!x.noQueue) {
      const k = slots[x.lane].indexOf(Math.min(...slots[x.lane]));
      slots[x.lane][k] = endAt(x.id);
      owner[x.lane][k] = x.id;
    }
  }
  // Non-enumerable so `start` stays a plain id -> day map to everything that
  // reads it, which is everything.
  Object.defineProperty(start, "why", { value: why });
  Object.defineProperty(start, "whyGap", { value: whyGap });
  Object.defineProperty(start, "whyWho", { value: whyWho });
  // THE ENDS IT ALREADY WORKED OUT, for a caller that would otherwise walk every
  // task's working hours again — `scoreOf`, once per candidate order.
  Object.defineProperty(start, "endAt", { value: (id: Id) => endAt(id) });
  return start;
}

// `cal` for the same reason `lanes` is a parameter, and it was missed once: this
// took the DEFAULT calendar while the reference plan was being measured, so with a
// five-day plan loaded the all-on reference finished at 8 instead of 6 and the
// self-test failed on a plan that was correct. Every function the reference plan
// touches has to be told which calendar to use, or the check measures whatever
// document happens to be open.
// A TASK WITH NO START DID NOT GET SCHEDULED, and the only way that happens is
// that it was dropped — `sched` places everything else or throws. Without the
// guard its missing start reaches `endOf` as `undefined`, comes back NaN, and
// NaN wins a `Math.max` outright: one abandoned task and the plan's finish date
// becomes "Invalid time value" everywhere it is rendered. Skipping is also the
// right answer on the merits, since abandoned work is not work the plan waits on.
export const finishOf = (tasks: Task[], st: Starts, cal: Cal) =>
  Math.max(...tasks.filter((t: Task) => st[t.id] !== undefined).map((t: Task) => endOf(t, st[t.id], cal)));

// Everything a task waits on, out to `max` hops. The direct `deps` list is a
// poor answer to "what has to happen before this can start" — a QA task can name
// three prerequisites and actually sit on top of nine, because each of those
// three drags its own chain along. Walk it iteratively rather than recursively:
// a cycle would otherwise blow the stack before sched() got the chance to
// report it properly.
//
// BREADTH-FIRST, ONE LEVEL PER TURN, and what comes back is a Map of task id ->
// HOP COUNT rather than a bare set. Two reasons, and the second is the load-
// bearing one:
//
//   1. A depth-first walk reaches a node by whatever path it happened to take
//      first, which is not the shortest one — so "stop at 2" would keep or drop
//      a task depending on the order `deps` was typed in. Level order gives every
//      task its MINIMUM hop count, the only reading of "two hops away" a person
//      will accept.
//   2. The arrows need to know how far out each END of an edge is, not merely
//      that both ends are somewhere in the chain. See drawArrows.
//
// The focus itself is in the map at 0. That is not a quirk to work around — it is
// what lets an edge INTO the focus come out at level 1.
export function hopsUp(tasks: Task[], tid: Id, max = Infinity) {
  const by = Object.fromEntries(tasks.map((t: Task) => [t.id, t]));
  const seen = new Map([[tid, 0]]);
  let front = [tid];
  for (let d = 1; d <= max && front.length; d++) {
    const next: Id[] = [];
    for (const x of front) for (const p of (by[x]?.deps || []))
      if (!seen.has(p)) { seen.set(p, d); next.push(p); }   // also what stops a cycle looping
    front = next;
  }
  return seen;
}

// ---- MIGRATIONS -----------------------------------------------------------
// A document format outlives every assumption you had when you wrote it, and the
// documents here are not all in one place: some are files on a disk, some are in
// a browser someone may not open for a year, some are in a file a colleague kept.
// So migration is a property of LOADING a document, wherever it came from — not
// a thing the browser store does.
//
// This is deliberately not Flyway. Flyway solves a shared mutable database with
// concurrent writers, partial application and rollback. This is one user's
// document. What that needs is a version integer and an ordered list of pure
// functions, applied in sequence.
//
// THE LOOP CHAINS, AND THAT IS THE POINT: a doc from ten versions ago walks every
// rung of the ladder in order and arrives current. Never renumber, never edit a
// shipped migration, only append — an old doc in someone's browser is depending
// on the exact ladder that existed when it was written.
//
// A RUNG MAY READ MORE THAN THE DOCUMENT, but only what its caller hands it in
// `MigrationContext` — never a clock, never the network — so it stays a pure
// function of its inputs. The server passes the plan's saved history and the
// time when it upgrades a stored plan (once: it saves the result). Other callers
// pass what they have, and a rung must behave sensibly given nothing.
export const SCHEMA = 9;

export interface MigrationContext {
  /** The plan's saved versions, oldest first. Each `doc` is at whatever schema
   *  it was saved at. */
  history?: { at: string; doc: Doc }[];
  /** An ISO instant standing for "now", supplied by the caller. */
  now?: string;
}

export const MIGRATIONS = [
  null,
  // v1 -> v2: `task.color` became a LIST. A task can touch two systems — a
  // shared server belongs to both applications on it — and the v1 workaround was
  // to invent a combined value, which does not scale past a couple of systems and
  // is invisible to a filter for either half of it.
  //
  // Widening rather than renaming: the field keeps its name and every v1 value
  // becomes a one-element list, so a plan that never needed this is unchanged in
  // meaning and every read site sees one shape. A null colour becomes [], which
  // is a real state ("no system"), not an error.
  //
  // What this CANNOT do is unpick a combined value — "Rates API & MOAuth" is one
  // opaque id, and nothing in the document says it means two others. That is an
  // edit, not a migration: tick both real colours on the affected tasks, then
  // delete the combined value, which now removes itself from a task's list
  // instead of replacing the whole thing.
  (d: Doc) => ({ ...d, tasks: (d.tasks || []).map((t: any) => ({ ...t,
    color: t.color == null ? [] : Array.isArray(t.color) ? t.color : [t.color] })) }),

  // v2 -> v3: UNASSIGNED STOPS BEING A STATE. Every task points at a real value in
  // every channel; colour alone keeps `[]`, because a task can genuinely touch no
  // system and `[]` is the honest bottom of a LIST rather than a missing answer.
  //
  // The incoherence this ends: `border` was nullable AND had a value styled
  // "none" (two ways to say one thing), `fill` was nullable and silently DRAWN as
  // fills[0] while being counted as none of them, `shape` was nullable with an
  // explicit "—", and `lane` could not be null at all. Four channels, four rules.
  //
  // THE RULE HERE IS "PRESERVE APPEARANCE", NOT "ASSIGN THE FIRST VALUE", and the
  // difference is not academic. In every plan in this repo three tasks carry no
  // border and `borders[0]` is "dev" — assigning the first value would have grown
  // them a dotted rim they never had and moved dev's legend count from 10 to 13.
  // A migration that relabels data is worse than the incoherence it removes.
  //
  // A DEFAULT IS DESIGNATED ONLY WHERE ONE WAS ACTUALLY NEEDED — that is, only
  // where this migration had somewhere to put an unassigned task. A plan that
  // already answers every channel on every task has no "not applicable" value,
  // and inventing one would put a meaningless entry in its legend.
  (d: Doc) => {
    const out: Doc = { ...d, tasks: (d.tasks || []).map((t: any) => ({ ...t })) };
    const defaults: Record<string, Id> = { ...((out.defaults as Record<string, Id>) || {}) };
    const mint = (pre: string, list: ChannelValue[], extra: Record<string, unknown>): ChannelValue => {
    let n = 1, v: string;
      do { v = pre + n++; } while (list.some((x: ChannelValue) => x.id === v));
      return { id:v, label:"—", ...extra }; };
    const stray = (field: any, list: any) =>
      out.tasks.filter((t: any) => t[field] == null || !list.some((x: any) => x.id === t[field]));

    // LANES. Already total everywhere — a task with no lane has no row to sit in —
    // so this only catches a hand-edited file. No default is designated: "which
    // queue is this in" is not a question a plan can decline to answer.
    out.lanes = [...(out.lanes || [])];
    if (!out.lanes.length) out.lanes.push(mint("t", out.lanes, { label:"Everything", cap:1 }));
    for (const t of stray("lane", out.lanes)) t.lane = out.lanes[0].id;

    // BORDERS. A null border drew NO RIM, and a value styled "none" draws exactly
    // that — so the target is that value: reused if the plan has one, created if
    // it does not. This is the channel the "preserve appearance" rule was written
    // for.
    out.borders = [...(out.borders || [])];
    const strayB = stray("border", out.borders);
    if (strayB.length) {
      let na = out.borders.find((x: ChannelValue) => x.style === "none");
      if (!na) { na = mint("b", out.borders, { style:"none" }); out.borders.push(na); }
      for (const t of strayB) t.border = na.id;
      defaults.borders = na.id;
    }
    if (!out.borders.length) out.borders.push(mint("b", out.borders, { style:"none" }));

    // FILLS. A DIFFERENT RULE, because a null fill did not draw as nothing:
    // `fillDef` fell back to fills[0], so an unassigned task was DRAWN as the
    // first value while being COUNTED as none of them. That fallback is the
    // silent misinformation this rung exists to end, so the honest target is the
    // value it was already being drawn as — and no default is designated, because
    // "how sure are we about this estimate" always applies. A plan that wants a
    // not-applicable fill can add one and it becomes deletable-to like any other.
    out.fills = [...(out.fills || [])];
    if (!out.fills.length) out.fills.push(mint("f", out.fills, { label:"unset", pattern:"solid" }));
    for (const t of stray("fill", out.fills)) t.fill = out.fills[0].id;

    // SHAPES. The channel is opt-in and simply absent from every plan written
    // before it existed, where a null shape drew as "soft". One value styled soft
    // reproduces that for the whole plan — and at one value it draws no legend
    // group and no inspector control, so a plan that never wanted shapes still
    // looks and reads exactly as it did.
    out.shapes = [...(out.shapes || [])];
    const strayS = stray("shape", out.shapes);
    if (strayS.length) {
      let na = out.shapes.find((x: ChannelValue) => (x.shape || "soft") === "soft");
      if (!na) { na = mint("s", out.shapes, { shape:"soft" }); out.shapes.push(na); }
      for (const t of strayS) t.shape = na.id;
      defaults.shapes = na.id;
    }
    if (!out.shapes.length) out.shapes.push(mint("s", out.shapes, { shape:"soft" }));

    out.defaults = defaults;
    return out;
  },

  // v3 -> v4: THE BASE UNIT BECOMES DAYS. Multiply every duration and every start
  // constraint by seven and the plan is unchanged — LOSSLESSLY, which is the good
  // news about doing it this way round. Half-weeks were the finest thing the old
  // unit could express and 0.5 * 7 = 3.5, which is exact in binary (any n/2 is),
  // so no plan loses a hair of precision on the way through. Every existing plan
  // comes out MORE precise than it went in, and nudging the odd 3.5 to a whole 4
  // is an edit someone can make later, by hand, on purpose.
  //
  // WHAT IS NOT TOUCHED: `start` and every milestone `date` are ISO strings, so
  // they were never in the base unit. `sprint.weeks` stays weeks, because a
  // sprint IS a number of weeks — it converts at the one place that renders it.
  (d: Doc) => ({ ...d, tasks: (d.tasks || []).map((t: any) => ({ ...t,
    dur: (t.dur || 0) * 7,
    ...(t.notBefore == null ? {} : { notBefore: t.notBefore * 7 }) })) }),

  // v4 -> v5: EVERY TASK SAYS WHEN IT WAS ADDED. `createdAt`/`updatedAt` shipped
  // on 2026-09-20 as optional fields with no rung of their own, so every task
  // older than that had neither. From v5 `createdAt` is required.
  //
  // Reconstructed from the saved history, so both are SAVE-GRAINED: `createdAt`
  // is the first save a task appears in, `updatedAt` the save in which its
  // label, description or duration last changed — absent when it never did,
  // which is what absent means. A stamp already present is better evidence than
  // any of this and is never replaced. A task no save contains (an import, a
  // fork) was added to THIS plan now, so `ctx.now`. Given neither — a read-only
  // view of an archived version — it is left absent rather than invented.
  //
  // Old saves are compared at v4, so v3 -> v4's weeks-to-days rewrite of every
  // `dur` does not read as an edit to every task.
  (d: Doc, ctx: MigrationContext = {}) => {
    const saves = (ctx.history || []).map(v => ({
      at: v.at, tasks: new Map<Id, any>(((v.doc.schemaVersion ?? 1) >= 4 ? v.doc
        : applyMigrations(structuredClone(v.doc), MIGRATIONS, 4)).tasks.map((t: any) => [t.id, t])) }));
    const wording = (t: any) => JSON.stringify([t.label, t.desc ?? null, t.dur]);
    return { ...d, tasks: (d.tasks || []).map((t: any) => {
      let created: string | undefined, updated: string | undefined, prev: string | undefined;
      for (const v of saves) {
        const old = v.tasks.get(t.id);
        if (!old) { prev = undefined; continue; }
        created ??= v.at;
        const w = wording(old);
        if (prev !== undefined && w !== prev) updated = v.at;
        prev = w;
      }
      const out = { ...t };
      if (out.createdAt === undefined && (created ?? ctx.now)) out.createdAt = created ?? ctx.now;
      if (out.updatedAt === undefined && updated) out.updatedAt = updated;
      return out;
    }) };
  },
  // v5 -> v6: THE FIVE TASK TIMES BECOME INSTANTS. Each day number `n` becomes
  // the instant whose wall clock in the plan's zone is `start + n` — the exact
  // moment the scheduler already meant, so no date on the chart moves. That
  // includes the whole-day convention: an integer `actualEnd` of 8 ("until the
  // end of day 7") becomes local midnight starting day 8, the same instant.
  //
  // THE ZONE IS THE DOCUMENT'S OR A CONSTANT, NEVER THE RUNTIME'S. This rung runs
  // in the page with no context (history versions) and in the server with
  // context, and both must produce identical instants, so it may not ask the
  // process where it is. Every pre-v6 plan was written in Central time.
  (d: Doc) => {
    const z = { ...d, timeZone: d.timeZone || DEFAULT_TZ };
    return { ...z, tasks: (d.tasks || []).map((t: any) => {
      const o = { ...t };
      // Its own list, not `WHEN_FIELDS`: v8 retired two of these, and a shipped rung never changes.
      for (const k of ["notBefore", "actualStart", "actualEnd", "refinedAt", "due"])
        if (typeof o[k] === "number") o[k] = instantOfDay(o[k], z);
      return o;
    }) };
  },
  // v6 -> v7: `dur` BECOMES WHOLE MINUTES. A day is 1440 — the scheduler's day
  // is 24 hours of lane time — so every exact value schedules exactly as it did.
  // The ones that were not a whole minute were decimal guesses and round to the
  // nearest five (`minutesOf`), which moves them by at most 2.5 minutes. Pure,
  // like every rung: history versions migrate on read and must agree.
  (d: Doc) => ({ ...d, tasks: (d.tasks || []).map((t: any) =>
    typeof t.dur === "number" ? { ...t, dur: t.dur > 0 ? minutesOf(t.dur) : t.dur } : t) }),
  // v7 -> v8: SESSIONS ARE THE ONLY RECORD OF WORK (ADR 0016). `actualStart` and `actualEnd` go; a finished
  // task says so with `done: true`. Finished work with no sessions becomes ONE session over its old actuals, so
  // its bar and its finish are exactly what they were. Work that has sessions keeps them; where the old start
  // came before the first session, or the old finish after the last stop (both happened: a start typed in by
  // hand, a finish recorded hours after the last stop), that moment becomes a session of NO LENGTH, so no
  // date moves and no worked time is invented. A start with no finish and no sessions becomes one too: the
  // task reads as paused rather than inventing a running clock. Pure, like every rung: history versions
  // migrate on read and must agree.
  (d: Doc) => ({ ...d, tasks: (d.tasks || []).map((t: any) => {
    const { actualStart: a, actualEnd: e, ...o } = t;
    if (a == null && e == null) return o;
    const ss = o.sessions?.length ? o.sessions.map((s: Session) => ({ ...s })) : [];
    if (!ss.length) ss.push({ start: a ?? e, stop: e ?? a });
    else {
      if (a != null && Date.parse(a) < Date.parse(ss[0].start)) ss.unshift({ start: a, stop: a });
      const last = ss[ss.length - 1];
      // A finished task still running is what `setActuals` used to close at the finish, so the rung does too.
      if (e != null && last.stop === null) last.stop = Date.parse(e) > Date.parse(last.start) ? e : last.start;
      else if (e != null && Date.parse(e) > Date.parse(last.stop)) ss.push({ start: e, stop: e });
    }
    o.sessions = ss;
    if (e != null) o.done = true;
    return o;
  }) }),
  // v8 -> v9: A TASK HOLDS ONLY ITS OWN FIELDS. `addTask` used to store any key it was sent, so a misspelt one
  // (`description` for `desc`) sat where nothing read it; every key not on this list goes, and from v9 the
  // document check refuses one. Its own list, not `TASK_FIELDS`: a shipped rung never changes.
  (d: Doc) => {
    const keep = new Set(["id", "label", "desc", "url", "ref", "lane", "border", "fill", "shape", "color", "dur",
      "deps", "ms", "notBefore", "noQueue", "planned", "recur", "sessions", "done", "refinedAt", "createdAt",
      "updatedAt", "comments", "due"]);
    return { ...d, tasks: (d.tasks || []).map((t: any) =>
      Object.fromEntries(Object.entries(t).filter(([k]) => keep.has(k)))) };
  },
];

// Pure and parameterised so the self-test can drive it with a synthetic ladder.
// Testing the migrator matters more than testing any one migration: the
// migrations are trivial, the sequencing is what silently ruins data.
export function applyMigrations(d: Doc, ladder: any[] = MIGRATIONS, target = SCHEMA,
                                ctx: MigrationContext = {}) {
  // An unstamped doc is v1, not v0. Every plan written before versioning existed
  // is structurally a v1 — treating them as v0 would demand a v0->v1 migration
  // that does nothing, which is a rung that exists only to be tripped over.
  let v = d.schemaVersion ?? 1;
  if (v > target) throw new Error(`this plan was written by a newer version (v${v} > v${target})`);
  while (v < target) {
    const step = ladder[v];
    if (!step) throw new Error(`no migration from v${v} — cannot upgrade this plan`);
    d = step(d, ctx);
    v++;
  }
  d.schemaVersion = target;
  return d;
}

// ---- THE WHOLE ANSWER FOR ONE DOCUMENT -------------------------------------
// What `/verdict` returns and what the chart's milestone chips say, from the same
// arithmetic — so an agent asking "what does this land on" cannot be told
// something the room is not being told.
//
// Migrated on the way in, exactly like every load path in the browser: a document
// that arrives at an older schema is answered for, not rejected.
/** Per-task readiness, over the wire.
 *
 *  THE CHART COULD ANSWER THIS AND THE API COULD NOT, which is the violation
 *  ADR 0008 exists to stop. `sched` already computes WHY each task starts where
 *  it does, and hangs it off its own result with `Object.defineProperty` — so
 *  it survives a function call inside the page and disappears through
 *  `JSON.stringify` on the way out. A cold agent asked "what can I start now"
 *  and had to fetch `/schedule.js` and run the scheduler itself to find out.
 *
 *  THE SAME RULE THE PAGE USES, deliberately, rather than a second definition
 *  that would drift: ready means not yet started and nothing holding it —
 *  `why` of `today` or `free` is the scheduler saying "nothing in this plan
 *  wanted it later, the calendar alone moved it". Anything else names the thing
 *  in the way, and that name is the useful half.
 *
 *  Started, finished and abandoned work is `null` rather than `false`: "can I
 *  pick this up" is not a question about work already underway, and answering
 *  `false` would read as "blocked". */
export function readiness(raw: Doc) {
  const stored = applyMigrations(structuredClone(raw)), d = dayNumbers(stored);
  const cal = calOf(d), now = nowOf(d);
  const st = sched(d.tasks, d.lanes || [], cal, now, now); // floor: now — see FORECASTS START NOW in sched
  const why = (st as any).why || {};
  // INSTANTS, like `due` beside them. These were dates — "the scheduler's
  // day-grained forecast" — which stopped being true when working hours gave
  // every start a clock: an agent could not tell 8am from 4pm.
  const iso = (n: number) => instantOfDay(n, d);
  const done = new Set(d.tasks.filter((t: Task) => t.done).map((t: Task) => t.id));
  const { rank } = rankOf(stored);
  const { rank: sRank } = suggestedRankOf(stored);

  return d.tasks.map((t: Task) => {
    const status = statusOf(t);
    const w = why[t.id];
    // TWO THINGS HAVE TO BE TRUE, and only one of them is in the schedule. The
    // scheduler answers whether anything is holding the task; `refinedAt`
    // answers whether a human has read it and agreed with what it says. A task
    // nobody has approved is not something to pick up this morning, and an
    // agent asking this endpoint what is ready has to get the answer the chart
    // gives — the page's `readyOf` makes exactly this pair.
    // OR ITS START HAS ALREADY COME. `why` names what decided the start, and a
    // lane that freed at 6am still "decided" a start of 6am — which is in the
    // past at 7am, so nothing is holding the task any more. Measured against
    // midnight alone, a one-lane plan with any work done today had nothing
    // ready until tomorrow. The page's `readyOf` makes the same comparison.
    const scheduled = status !== "todo" || w === undefined ? null
      : (w === "today" || w === "free" || st[t.id]! <= now + 1e-9);
    const ready = scheduled === null ? null : scheduled && t.refinedAt != null;
    return {
      id: t.id,
      status,
      ready,
      // WHAT is in the way, in the scheduler's own words — `deps`, `notBefore`
      // or `lane`, and `unrefined` when the schedule is clear and the sign-off
      // is the only thing left. Null when nothing is, or when the question does
      // not apply. Ranked after the scheduling reasons: a blocked task that is
      // also unrefined reports the blocker, because that is what has to move
      // first.
      waitingOn: ready === false ? (scheduled ? "unrefined" : w) : null,
      // Only the unfinished ones. A dependency already done is not a blocker,
      // and listing it would make a ready task look held up.
      blockedBy: (t.deps || []).filter((x: Id) => !done.has(x)),
      starts: st[t.id] === undefined ? null : iso(st[t.id]!),
      ends: st[t.id] === undefined ? null : iso(endOf(t, st[t.id]!, cal)),
      // THE INSTANT, as stored — a deadline has a time now, and a date would
      // throw it away.
      due: stored.tasks.find((x: StoredTask) => x.id === t.id)!.due ?? null,
      // Positive is slack, negative is late. Silent for work with no deadline
      // and for work nobody is going to do. Hundredths of a day (~15 min), not
      // whole days: rounding made a task late by an hour read `0`, on time.
      slackDays: t.due == null || t.done || st[t.id] === undefined
        ? null : Math.round((t.due - endOf(t, st[t.id]!, cal)) * 100) / 100,
      // THE PERSON'S ANSWER TO "what should happen first?" — 1 is first, ties share a
      // number. Null for a task not ranked yet, and for finished work, which leaves it.
      rank: rank.get(t.id) ?? null,
      // WHERE AN UNADOPTED SUGGESTION PUTS IT, kept apart from the person's own `rank`. Null when
      // there is no suggestion or it does not cover this task.
      suggestedRank: sRank.get(t.id) ?? null,
    };
  });
}

/** The Board's four columns — Blocked, Ready, In progress, Done — each a list
 *  of `readiness()` rows in reading order.
 *
 *  BUILT ON `readiness()` AND NOTHING ELSE, so the board cannot disagree with
 *  `/api/ready`. That includes its strictness: an unrefined task nothing is
 *  holding lands in Blocked with `waitingOn: "unrefined"`, because that is what
 *  the API says about it. The fix for a crowded Blocked column is refining, not
 *  a softer board.
 *
 *  DONE IS A WINDOW, not a history — `win` days (7 unless the viewer asks for
 *  more) of work whose last day falls inside it. A VIEW setting, not the plan's:
 *  it was `doc.doneWindow` until 2026-09-26, and every look back rewrote the plan. `actualEnd` is exclusive, so the last
 *  day worked is `actualEnd - 1`. Older work is on the timeline and in History.
 *
 *  IN PROGRESS IS TWO GROUPS, running (a session open) and paused (worked on,
 *  none open), each oldest-started first. Waiting columns read in
 *  scheduled-start order, which already has the queue and the dependencies in
 *  it; Done newest first. */
export function boardColumns(raw: Doc, win = 7) {
  const today = todayOf(raw);
  const byId = new Map(dayNumbers(applyMigrations(structuredClone(raw))).tasks.map((t: Task) => [t.id, t]));
  const cols = { blocked: [] as any[], ready: [] as any[], running: [] as any[], paused: [] as any[], done: [] as any[] };
  for (const r of readiness(raw)) {
    const t = byId.get(r.id)!;
    if (r.status === "done") { if (t.actualEnd! - 1 > today - win) cols.done.push(r); }
    else if (r.status === "running" || r.status === "paused") cols[r.status as "running" | "paused"].push(r);
    else (r.ready ? cols.ready : cols.blocked).push(r);
  }
  // ISO dates sort as strings; an unplaced task (no `starts`) goes last.
  const byStart = (a: any, b: any) => (a.starts ?? "~").localeCompare(b.starts ?? "~");
  const f = (k: "actualStart" | "actualEnd") => (r: any) => byId.get(r.id)![k]!;
  cols.blocked.sort(byStart);
  cols.ready.sort(byStart);
  for (const g of [cols.running, cols.paused]) g.sort((a, b) => f("actualStart")(a) - f("actualStart")(b));
  cols.done.sort((a, b) => f("actualEnd")(b) - f("actualEnd")(a));
  return cols;
}

export function verdict(raw: Doc) {
  const d = dayNumbers(applyMigrations(structuredClone(raw)));
  const cal = calOf(d);
  // The same floor the chart applies. An agent asking "what does this land on"
  // and the room reading the milestone chips have to get one answer, and a
  // wire that skipped the floor would hand the agent the stale, cheerful one.
  const st = sched(d.tasks, d.lanes || [], cal, nowOf(d), nowOf(d));
  // WORK THIS PLAN IS ACTUALLY WAITING ON, which is the list every count below
  // is taken over. `sched` deliberately still places dropped tasks — the page
  // needs a start for every row (see the note in `sched`) — so the schedule
  // cannot answer this and the field has to.
  //
  // It filtered out abandoned work here until 2026-09-20; there is no such work
  // any more, so it is every task.
  const live = d.tasks;
  const origin = Date.parse(d.start + "T00:00:00Z");
  // THE MOMENT WORK STOPS, as an instant. This was the date of the last day worked,
  // which was right while finishes were whole days and hid the hour once they
  // were not: "finish 2026-12-14, met: false" read as a contradiction.
  const iso = (n: number) => instantOfDay(n, d);
  const dayOf = (s: string) => (Date.parse(s + "T00:00:00Z") - origin) / DAY;
  const msOf = (t: Task) => t.ms || ((d.milestones || [])[0] || {}).id;

  const milestones = (d.milestones || []).map((m: any) => {
    // A milestone is not met until every task assigned to it AND everything those
    // tasks wait on is done. Reporting only the assigned tasks would flatter it.
    const own = live.filter((t: Task) => msOf(t) === m.id);
    if (!own.length) return { id: m.id, label: m.label, date: m.date, tasks: 0, finish: null, met: null };
    const all = new Set<Id>(own.map((t: Task) => t.id));
    for (const t of own) for (const a of hopsUp(live, t.id).keys()) all.add(a);
    const by = Object.fromEntries(live.map((t: Task) => [t.id, t]));
    const f = Math.max(...[...all].map(id => by[id] ? endOf(by[id], st[id], cal) : 0));
    const due = dayOf(m.date);
    // TWO COUNTS, TWO NAMES. `tasks` is what the chart's chip says — the tasks
    // ASSIGNED to this milestone — and `waitsOn` is the closure the date is
    // actually computed over. Reporting the closure as "tasks" made this endpoint
    // disagree with the chip beside it (9 against 4) while both were right about
    // different things, which is the one failure this whole module exists to
    // avoid.
    return { id: m.id, label: m.label, date: m.date,
             tasks: own.length, waitsOn: all.size,
             finish: iso(f), met: f <= due + 1e-9, byDays: Math.round((f - due) * 100) / 100 };
  });
  return { tasks: live.length, start: d.start,
           finish: iso(finishOf(live, st, cal)), milestones };
}

// ---------------------------------------------------------------------------
// QUEUE ORDER IS A SCHEDULING INPUT, AND NOTHING WAS CHECKING IT.
//
// A lane is a serial queue and ties break by position in `tasks`, so the array
// order IS the order that team works in — `README.md` says so about the ↑/↓
// controls. What it could not say was WHICH row to move. This answers that.
//
// It was written because the real plan had a 32-day error in it that nobody
// could see: two 10-day F5 tasks with no dependents sat in front of the pair the
// entire QA chain was waiting on. The same mistake had been found once before,
// by hand, in a different lane. It hides because a lane grouped tidily by
// service is exactly what puts the wrong one first.
//
// IT SUGGESTS. IT NEVER APPLIES. That is not timidity, it is the measured
// finding: run to convergence on a real plan and the machine will bury a
// de-risking spike at position 21 to save two days on a task that gates nothing.
// The objective function knows finish dates. It does not know that a spike
// exists to answer a question EARLY, or that one milestone is a legal deadline
// and another is a preference. A human has to see the move before it happens.
//
// COST is O(lane²) schedules per lane. The closures below are hoisted out of
// that loop because they depend on dependencies and milestone assignment, which
// reordering cannot change — computing them inside made this ~40x slower for
// identical answers.
function msClosures(tasks: Task[], milestones: any) {
  const fallback = (milestones[0] || {}).id;
  const out: { id: Id; label: string; ids: Id[] }[] = [];
  for (const m of milestones) {
    const own = tasks.filter((t: Task) => (t.ms || fallback) === m.id);
    if (!own.length) continue;
    const all = new Set<Id>(own.map((t: Task) => t.id));
    for (const t of own) for (const a of hopsUp(tasks, t.id).keys()) all.add(a);
    out.push({ id: m.id, label: m.label, ids: [...all] });
  }
  return out;
}

function scoreOf(tasks: Task[], lanes: ChannelValue[], cal: Cal, closures: any, today: number,
                 raw_dueBuffer: number = 0, now = Infinity) {
  const st = sched(tasks, lanes, cal, today, now);
  const end = (st as any).endAt as (id: Id) => number;
  const by = Object.fromEntries(tasks.map((t: Task) => [t.id, t]));
  const ms: Record<Id, unknown> = {};
  for (const c of closures)
    ms[c.id] = Math.max(...c.ids.map((id: Id) => by[id] ? end(id) : 0));
  // ---- TOTAL TARDINESS: days late, summed over every task with a deadline ----
  //
  // THE OBJECTIVE THIS SEARCH WAS MISSING, and without it the whole feature is
  // silent on the commonest plan there is. `finish` and the milestone dates were
  // the only two things scored, so on a plan with no milestones the only
  // objective was `finish` — and in a SINGLE SERIAL LANE the finish date is
  // invariant under reordering: same work, one worker, no gaps, so the last task
  // lands at the same moment whatever order you do things in. Every permutation
  // therefore scored exactly zero and the panel truthfully reported "nothing to
  // improve" over a queue with three blown deadlines in it. Measured on the real
  // plan, 2026-09-20: 81 tasks, one lane, `suggestions: []`, while `wd-redate`
  // was missing its deadline by 3.16 days purely because of queue position.
  //
  // SUM, NOT MAXIMUM. Minimising the worst single miss (Jackson's rule) leaves a
  // plan happy to make three tasks two days late rather than one task three, and
  // on a plan of promises every miss is its own broken promise. The sum counts
  // them all; the panel's `worsens` flag is what catches a move that fixes two
  // deadlines by wrecking a third.
  //
  // WORK THAT IS OVER IS NOT SCORED. A finished or abandoned task's end date
  // cannot move, so including it would add the same constant to every candidate
  // — and, worse, would price history as if reordering could still save it. The
  // same rule `dueOf` applies in the page.
  //
  // DAYS, like every other term here, so the gains are commensurable and the
  // existing `max(gains)` / `min(gains)` trade logic needs no scaling factor.
  //
  // ---- AND `tight`: THE SAME SUM AGAINST A DEADLINE BROUGHT FORWARD ---------
  //
  // TARDINESS IS A HINGE AND A HINGE HAS NO SLOPE ON THE SAFE SIDE. `max(0, end
  // - due)` is flat at zero for everything on time, so the moment the search
  // gets a task over the line it stops caring — and what it leaves behind is a
  // plan balanced on a knife edge. Measured on the real plan the day tardiness
  // shipped: total lateness zero, and `sm-review` finishing at 16:56 against a
  // 17:00 deadline scoring a perfect nought. Six tasks inside two hours of
  // their deadlines, and the objective reported them as ideal.
  //
  // So the elbow moves left by `buffer` days. Work with comfortable margin still
  // scores zero and is left alone; work inside the buffer registers as if it
  // were already late and gets pulled forward. It is a FICTION FOR THE SEARCH
  // ONLY — the Deadline reading, the inspector's "misses by / to spare" and
  // `/api/ready` all keep using the real date. Scoring against a date and then
  // reporting against it would just be moving everyone's deadlines earlier
  // while telling them otherwise.
  let tardy = 0, tight = 0;
  const buffer = Math.max(0, +raw_dueBuffer || 0);
  for (const t of tasks) {
    if (t.due == null || t.done) continue;
    const e = end(t.id);
    if (e > t.due) tardy += e - t.due;
    if (e > t.due - buffer) tight += e - (t.due - buffer);
  }
  return { finish: Math.max(...tasks.filter((t: Task) => st[t.id] !== undefined).map((t: Task) => end(t.id))),
           ms, tardy, tight };
}

// Returns the BEST single move for each task that has one, sorted by the biggest
// improvement it makes, in days. Every entry is measured independently against
// the CURRENT order — applying one invalidates the rest, which is why the caller
// re-runs after each apply rather than working down the list.
export function suggestReorders(raw: Doc,
                                opts: { maxLane?: number; limit?: number; buffer?: number } = {}) {
  const d = dayNumbers(applyMigrations(structuredClone(raw)));
  const cal = calOf(d), lanes = d.lanes || [];
  const maxLane = opts.maxLane ?? 40;
  // A PLAN-LEVEL JUDGEMENT WITH A DEFAULT OF NONE. How much room a deadline
  // wants differs per plan, so it lives on the document (`dueBuffer`, in days)
  // rather than being a constant here — and a plan that has never set one gets
  // the behaviour it had before the term existed, which is the only honest
  // default for a change to what "a better order" means.
  const buffer = opts.buffer ?? (+(d as any).dueBuffer || 0);
  const closures = msClosures(d.tasks, d.milestones || []);
  // Measured against the plan the chart is showing, floor included. Scoring a
  // reorder without it prices a move by how much it would have helped on the
  // day the plan was written — and it flatters every suggestion, because work
  // the floor has already pinned to today cannot be pulled any further left.
  const now = nowOf(d), today = now; // the forecast floor is now, like every other caller
  const base = scoreOf(d.tasks, lanes, cal, closures, today, buffer, now);
  // MOST CANDIDATE ORDERS ARE THE SAME ORDER. A task with an actual start is
  // placed at that start whatever its row, and the lane slots the started tasks
  // hold end up as their latest ends — a top-k, which order cannot change. So
  // the schedule depends only on the sequence of the tasks not yet started.
  // Moving a finished task, or moving an open one past finished ones, lands on
  // a sequence already scored: 240 rows with 154 done was 57,000 schedules for
  // at most 86 × 86 distinct ones. Scored once each, and the answer is the same
  // bytes — `test/reorder-dedupe.test.ts` holds it to that.
  // PAUSED WORK QUEUES (ADR 0018), so its row is part of the sequence; leaving it out scored every move past it as no move.
  const keyOf = (ts: Task[]) => ts.filter((t: Task) => t.actualStart == null || statusOf(t) === "paused").map((t: Task) => t.id).join("\n");
  const scored = new Map([[keyOf(d.tasks), base]]);
  const byId = Object.fromEntries(d.tasks.map((t: Task) => [t.id, t]));
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  /** One suggested move: which row, which lane, and what it is worth. */
  const suggestions: {
    lane: Id; id: Id; label: string; from: number; to: number;
    after: Id | null; gain: number; gains: Record<string, number>; worsens: boolean;
    /** Pairs this move brings into line with the ranking — set on a move made ONLY for that. */
    ranked?: number;
    /** True when `ranked` counts pairs of a SUGGESTION and not the person's own ranking. */
    suggested?: true;
    /** True when `ranked` counts paused tasks put ahead of unstarted ones (ADR 0019). */
    paused?: true;
  }[] = [];
  // THE RANKING AS A TIE-BREAK, NEVER AS A COST. Dates decide; where every date term
  // ties, the order that disagrees with fewer ranked pairs wins. It is a second key,
  // compared only when the first is equal, so no ranking can buy back a day: a move is
  // a ranking move only if it changes no date term at all. Pairs where either task is
  // unranked, or the two are tied, never count — no opinion is not a disagreement.
  const { rank } = rankOf(d as any);
  // A SUGGESTED RANKING IS THE SAME COUNT UNDER A WEAKER KEY (the person's ranking first, this second): it speaks only
  // on pairs the person has not settled — a pair where both tasks have a ranking of their own is
  // theirs, and is skipped — and only when their ranking is indifferent. `useRankSuggestion: false`
  // turns it off.
  const sRank = d.useRankSuggestion === false ? new Map<Id, number>() : suggestedRankOf(d as any).rank;
  /** Disagreements with one ranking. `skip` leaves out pairs another ranking has already settled. */
  const disagreements = (rk: Map<Id, number>, skip: (x: Id, y: Id) => boolean = () => false) => ({
    /** Out-of-order pairs in one queue. */
    total: (o: Id[]) => {
      let n = 0;
      for (let i = 0; i < o.length; i++) {
        const ri = rk.get(o[i]!);
        if (ri === undefined) continue;
        for (let j = i + 1; j < o.length; j++) {
          const rj = rk.get(o[j]!);
          if (rj !== undefined && ri > rj && !skip(o[i]!, o[j]!)) n++;
        }
      }
      return n;
    },
    // WHAT ONE MOVE DOES TO THAT COUNT, without recounting the lane: only the pairs
    // the moved row forms with the rows it jumps over can change. `gained - lost` equals
    // `total(before) - total(after)`, and this is O(distance) instead of O(n²). They are kept
    // apart because a move that fixes one pair and breaks another nets to nothing yet still
    // costs somebody a pair.
    delta: (ids: Id[], from: number, to: number) => {
      const rx = rk.get(ids[from]!);
      let lost = 0, gained = 0;
      if (rx === undefined) return { lost, gained };
      const lo = from < to ? from + 1 : to, hi = from < to ? to : from - 1;
      for (let k = lo; k <= hi; k++) {
        const ry = rk.get(ids[k]!);
        if (ry === undefined || skip(ids[from]!, ids[k]!)) continue;
        // Moving later: x now comes after y. Moving earlier: before it.
        const [a, b] = from < to ? [ry, rx] : [rx, ry];
        if (a > b) lost++; else if (b > a) gained++;
      }
      return { lost, gained };
    },
  });
  const confirmed = disagreements(rank);
  const suggested = disagreements(sRank, (x, y) => rank.has(x) && rank.has(y));
  // PAUSED BEFORE UNSTARTED (ADR 0019), a key between the dates and the person's ranking: finish what was started, unless a
  // date says otherwise. Counted as a two-level ranking, so a ranking or suggested move may not break one of its pairs.
  // Work that does not queue, or is held by its plan, has no row worth moving and no opinion here.
  const pRank = new Map<Id, number>();
  for (const t of d.tasks) if (!t.noQueue && !plannedOf(t)) {
    const st = statusOf(t);
    if (st === "paused" || st === "todo") pRank.set(t.id, st === "paused" ? 0 : 1);
  }
  const firsts = disagreements(pRank);
  const skipped: { lane: Id; tasks: number }[] = [];

  for (const lane of lanes) {
    const slots = d.tasks.map((t: Task, i: number) => (t.lane === lane.id ? i : -1)).filter((i: number) => i >= 0);
    if (slots.length < 2) continue;
    // A guard, not a policy: the cost is quadratic and a lane this long is a
    // different problem. Reported rather than silently dropped — a suggester
    // that quietly skips half the plan reads as "nothing to improve".
    if (slots.length > maxLane) { skipped.push({ lane: lane.id, tasks: slots.length }); continue; }
    const ids = slots.map((i: number) => d.tasks[i].id);
    // ONLY A ROW THAT QUEUES IS WORTH MOVING, OR MOVING PAST. Started work (`keyOf`), work that does not queue and work
    // held by a plan still ahead are placed whatever their row, and are in no paused-first pair. Trying them anyway was
    // most of the search: 572 rows, 259 of them meetings and exempt work, 392 s a step. Landing on another queuing row's
    // index covers every distinct order of the queue, and `to` stays a lane index, which is what `moveTaskInLane` takes.
    const moves = ids.map((id: Id) => {
      const t = byId[id], pl = plannedOf(t);
      return (t.actualStart == null || statusOf(t) === "paused") && !t.noQueue && !(pl && pl[pl.length - 1]!.stop > today);
    });
    const baseRank = rank.size ? confirmed.total(ids) : 0;
    const baseSugg = sRank.size ? suggested.total(ids) : 0;
    // No paused task in the lane, no pair for any move to fix or break: skip the count.
    const hasPaused = ids.some((id: Id) => pRank.get(id) === 0), basePaused = hasPaused ? firsts.total(ids) : 0;
    for (let from = 0; from < ids.length; from++) {
      if (!moves[from]) continue;
      /** The best move this row can make purely to agree with the ranking. */
      let byRank: typeof suggestions[number] | null = null;
      /** The same for the suggestion, which only ever fills in where the ranking has no opinion. */
      let bySugg: typeof suggestions[number] | null = null;
      /** The same for paused-before-unstarted, which outranks both. */
      let byPaused: typeof suggestions[number] | null = null;
      /** The best move found for this lane so far. `after` names the row it
       *  would land behind, `gains` is per-milestone, and `worsens` says a move
       *  that buys one milestone costs another — see the note at the literal. */
      let best: {
        lane: Id; id: Id; label: string; from: number; to: number;
        after: Id | null; gain: number; gains: Record<string, number>; worsens: boolean;
      } | null = null;
      for (let to = 0; to < ids.length; to++) {
        if (to === from || !moves[to]) continue;
        const o = ids.slice();
        o.splice(to, 0, o.splice(from, 1)[0]);
        const tasks = d.tasks.slice();
        o.forEach((id: Id, k: number) => { tasks[slots[k]] = byId[id]; });
        const key = keyOf(tasks);
        let s = scored.get(key);
        if (!s) scored.set(key, s = scoreOf(tasks, lanes, cal, closures, today, buffer, now));
        // A REAL MISSED DEADLINE IS NOT CURRENCY. `tight` and `tardy` are in the
        // same unit and would otherwise trade one for one — half a day of
        // breathing room bought by making something genuinely late, offered as
        // an improvement with a `worsens` flag on it. A broken promise is a
        // different KIND of thing from a tight one, so this is a constraint
        // rather than a cost: a candidate that increases real lateness is not
        // considered at all.
        if (s.tardy > base.tardy + 1e-9) continue;
        const gains: Record<string, number> = { finish: round(base.finish - s.finish),
                                                tardy: round(base.tardy - s.tardy),
                                                tight: round(base.tight - s.tight) };
        for (const c of closures) gains[c.id] =
        round((base.ms[c.id] as number) - (s.ms[c.id] as number));
        const gain = Math.max(...Object.values(gains));
        const cost = Math.min(...Object.values(gains));
        if ((basePaused || baseRank || baseSugg) && gain <= 1e-9 && cost >= -1e-9) {
          const pz = hasPaused ? firsts.delta(ids, from, to) : { lost: 0, gained: 0 }, put = pz.gained - pz.lost;
          if (put > 0 && (!byPaused || put > byPaused.ranked!))
            byPaused = { lane: lane.id, id: ids[from], label: byId[ids[from]].label, from, to,
                         after: to > 0 ? o[to - 1] : null, gain: 0, gains, worsens: false, ranked: put, paused: true };
          // The weaker keys only where it breaks no paused-first pair.
          if (pz.lost) continue;
          const own = rank.size ? confirmed.delta(ids, from, to) : { lost: 0, gained: 0 };
          const fixed = baseRank ? own.gained - own.lost : 0;
          if (fixed > 0 && (!byRank || fixed > byRank.ranked!))
            byRank = { lane: lane.id, id: ids[from], label: byId[ids[from]].label, from, to,
                       after: to > 0 ? o[to - 1] : null, gain: 0, gains, worsens: false, ranked: fixed };
          // Only when the move breaks none of the person's own pairs, whatever else it fixes for them.
          const sg = baseSugg && own.lost === 0 ? suggested.delta(ids, from, to) : { lost: 0, gained: 0 };
          const hint = sg.gained - sg.lost;
          if (hint > 0 && (!bySugg || hint > bySugg.ranked!))
            bySugg = { lane: lane.id, id: ids[from], label: byId[ids[from]].label, from, to,
                       after: to > 0 ? o[to - 1] : null, gain: 0, gains, worsens: false, ranked: hint, suggested: true };
        }
        if (gain > 1e-9 && (!best || gain > best.gain)) {
          best = { lane: lane.id, id: ids[from], label: byId[ids[from]].label,
                   from, to, after: to > 0 ? o[to - 1] : null, gain, gains,
                   // A move can buy one milestone and cost another. Surfacing
                   // only the gain is how a suggester talks someone into a trade
                   // they would not have taken.
                   worsens: cost < -1e-9 };
        }
      }
      if (best ?? byPaused ?? byRank ?? bySugg) suggestions.push((best ?? byPaused ?? byRank ?? bySugg)!);
    }
  }
  // Date gains first, always; ranking moves (gain 0) after them, most pairs fixed first.
  // Paused-first, then the person's own ranking, then a suggestion, then most pairs fixed.
  const kind = (x: typeof suggestions[number]) => x.paused ? 0 : x.suggested ? 2 : 1;
  suggestions.sort((a, b) => b.gain - a.gain || kind(a) - kind(b) || (b.ranked ?? 0) - (a.ranked ?? 0));
  return { base: { finish: base.finish, ms: base.ms, tardy: base.tardy, tight: base.tight },
           suggestions: suggestions.slice(0, opts.limit ?? 20), skipped };
}

// ---------------------------------------------------------------------------
// WHICH TEAM GOES ON TOP. Lane order is the one thing on this chart with no rule
// at all: it is whatever order the lanes were typed in, and every plan here grew
// its lanes one meeting at a time.
//
// THE LAW: a lane sits ABOVE the lanes that wait on it, as far as the
// dependencies allow. Read top to bottom and the work flows downward.
//
// It cannot always be satisfied, and that is why this is a search rather than a
// topological sort. Lane graphs have cycles that task graphs cannot -- QA waits
// on a server AND a server build waits on QA passing, both true, both in the real
// plan -- so some arrows must point up. This minimises the WEIGHT of those: count
// every task-level dependency that crosses lanes, and order the lanes so the
// fewest of them run backwards.
//
// Measured on the plan it was written for: the typed-in order left 25 of 84
// crossing dependencies pointing up. Sorting by when work STARTS made it WORSE
// (34), by centre of mass worse (29), by when work ENDS better (18). This gets 7.
//
// TIES ARE BROKEN BY STAYING PUT. Four orders tied at the optimum on that plan,
// so the second key is total displacement from the order you already have: the
// button never shuffles a lane it had no reason to move, and running it twice
// changes nothing the second time.
export function laneOrder(raw: Doc) {
  const d = dayNumbers(applyMigrations(structuredClone(raw)));
  const lanes = (d.lanes || []).map((l: ChannelValue) => l.id);
  const by = Object.fromEntries(d.tasks.map((t: Task) => [t.id, t]));

  const w = new Map();
  for (const t of d.tasks) for (const dep of t.deps || []) {
    const a = by[dep] && by[dep].lane, b = t.lane;
    if (!a || !b || a === b) continue;
    const k = a + " " + b;
    w.set(k, (w.get(k) || 0) + 1);
  }
  const E = [...w].map(([k, n]) => { const [a, b] = k.split(" "); return { a, b, n }; });
  const total = E.reduce((s, e) => s + e.n, 0);
  const home: Record<Id, number> =
    Object.fromEntries(lanes.map((l: Id, i: number): [Id, number] => [l, i]));
  const cost = (o: any) => {
    const p: Record<Id, number> =
      Object.fromEntries(o.map((l: Id, i: number): [Id, number] => [l, i]));
    return E.reduce((s, e) => s + (p[e.a] > p[e.b] ? e.n : 0), 0);
  };
  const drift = (o: any) => o.reduce((s: number, l: Id, i: number) => s + Math.abs(i - home[l]), 0);
  const better = (a: any, b: any) => (a.c !== b.c ? a.c < b.c : a.d < b.d);

  let best = { o: lanes.slice(), c: cost(lanes), d: 0 };
  // EXACT BELOW NINE LANES, which is every plan anyone has built with this and a
  // long way past it. 8! is 40320 orders costed against a handful of edges --
  // milliseconds -- and an exact answer needs no explaining. Above that, the same
  // insertion hill-climb `suggestReorders` uses, started from the current order,
  // so it stays deterministic and can never be worse than what you already had.
  if (lanes.length <= 8) {
    const walk = (rest: any, cur: any) => {
      if (!rest.length) {
        const cand = { o: cur, c: cost(cur), d: drift(cur) };
        if (better(cand, best)) best = cand;
        return;
      }
      for (let i = 0; i < rest.length; i++)
        walk(rest.slice(0, i).concat(rest.slice(i + 1)), cur.concat(rest[i]));
    };
    walk(lanes, []);
  } else {
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (let from = 0; from < best.o.length; from++)
        for (let to = 0; to < best.o.length; to++) {
          if (from === to) continue;
          const o = best.o.slice();
          o.splice(to, 0, o.splice(from, 1)[0]);
          const cand = { o, c: cost(o), d: drift(o) };
          if (better(cand, best)) { best = cand; moved = true; }
        }
      if (!moved) break;
    }
  }
  return { order: best.o, backward: best.c, total,
           was: cost(lanes), changed: best.o.join() !== lanes.join() };
}
