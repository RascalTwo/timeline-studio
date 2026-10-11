// A FASTER SETTLE MAKES THE SAME MOVES, IN THE SAME ORDER, AND LANDS ON THE SAME PLAN.
//
// Auto-order settles a plan by searching, applying the one best move, and searching again
// (`settleOnce` in src/rooms.ts). Speeding the search up must not change a single one of
// those moves: same task, same target row, same sequence, same final document. These
// digests were recorded from the code BEFORE the settle was made faster (2026-10-10), over
// invented plans shaped like a real personal plan: one long lane, most of it finished, a
// third of it meetings held by planned stretches, paused and running work, deadlines with a
// buffer, working hours, a ranking and a suggested ranking. The large plan is 673 tasks.
//
// A digest that stops matching means Auto-order now decides something differently. That
// is never silent: list each differing move with its before/after scores and get it
// accepted, then re-record with `SCHEDULE_MODULE=<old schedule.js> npx tsx --test
// test/settle-equivalence.test.ts`, which prints them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { applyCommand } from "../../shared/commands.js";

const m = await import(process.env["SCHEDULE_MODULE"] ?? "../../shared/schedule.js");

let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const NOW = Date.parse("2026-10-07T15:30:00Z");
const at = (days: number) => new Date(NOW + days * 864e5).toISOString();
const quarter = (days: number) => at(Math.round(days * 96) / 96);

/** An invented plan: `n` tasks, of which about `open` are unstarted work that queues. */
function plan(s: number, n: number, open: number, laneCount = 1): any {
  seed = s * 7919 + 13;
  const lanes = Array.from({ length: laneCount }, (_, i) => ({
    id: "L" + i,
    label: "L" + i,
    ...(rnd() < 0.2 ? { cap: 2 } : {}),
  }));
  const ms =
    rnd() < 0.4
      ? [
          { id: "m1", label: "m1", date: at(10).slice(0, 10) },
          { id: "m2", label: "m2", date: at(30).slice(0, 10) },
        ]
      : [];
  const tasks: any[] = [];
  const queued: any[] = [];
  for (let i = 0; i < n; i++) {
    const t: any = {
      id: "t" + i,
      label: "task " + i,
      lane: pick(lanes).id,
      border: "b",
      fill: "f",
      shape: "s",
      color: [],
      deps: [],
      dur: pick([15, 30, 60, 60, 120, 240, 480]),
      createdAt: at(-40),
    };
    const r = rnd();
    const rest = 1 - open / n;
    if (r < rest * 0.62) {
      // finished, a third of it exempt work
      const a = -30 + rnd() * 29;
      t.sessions = [{ start: quarter(a), stop: quarter(a + t.dur / 1440 + rnd() * 0.1) }];
      t.done = true;
      if (rnd() < 0.45) t.noQueue = true;
    } else if (r < rest * 0.97) {
      // a meeting: noQueue, held by planned stretches, some of them repeating weekly
      t.noQueue = true;
      const a = Math.floor(rnd() * 20) + pick([0.4, 0.55, 0.7, 0.85]);
      const k = rnd() < 0.3 ? 3 : 1;
      t.planned = Array.from({ length: k }, (_, j) => ({
        start: quarter(a + 7 * j),
        stop: quarter(a + 7 * j + pick([15, 30, 60, 120]) / 1440),
      }));
      t.dur = 15;
    } else if (r < rest) {
      // started: paused, or the one running
      const a = -3 + rnd() * 2;
      t.sessions = [{ start: quarter(a), stop: rnd() < 0.85 ? quarter(a + 0.02) : null }];
      if (rnd() < 0.3) t.noQueue = true;
    } else {
      if (rnd() < 0.15) t.noQueue = true;
      if (rnd() < 0.5) t.due = quarter(1 + rnd() * 25);
      if (rnd() < 0.08) t.notBefore = quarter(rnd() * 6);
      if (queued.length > 0 && rnd() < 0.12) t.deps.push(pick(queued).id);
      if (ms.length > 0 && rnd() < 0.5) t.ms = pick(ms).id;
      queued.push(t);
    }
    tasks.push(t);
  }
  const doc: any = {
    schemaVersion: 10,
    title: "p" + s,
    start: "2026-09-01",
    timeZone: "America/Chicago",
    autoOrder: true,
    lanes,
    borders: [{ id: "b", label: "b", style: "solid" }],
    fills: [{ id: "f", label: "f", pattern: "solid" }],
    shapes: [{ id: "s", label: "s", shape: "soft" }],
    colors: [],
    milestones: ms,
    tasks,
  };
  if (rnd() < 0.8) {
    const day = [["07:00", "20:00"]];
    doc.hours = {
      week: { mon: day, tue: day, wed: day, thu: day, fri: [["07:00", "23:59"]] },
      dates: {},
    };
    if (rnd() < 0.5) doc.hours.week.sat = [["08:00", "23:59"]];
  }
  if (rnd() < 0.6) doc.dueBuffer = pick([1, 2]);
  const cmd = (c: any) => {
    try {
      applyCommand(doc, { at: at(0), ...c });
    } catch {
      // a vote the plan refuses is just not cast
    }
  };
  for (let k = 0; k < queued.length * 0.6; k++) {
    const a = pick(queued),
      b = pick(queued);
    if (a.id !== b.id)
      cmd({ type: "addRankAnswer", a: a.id, b: b.id, verdict: pick([-1, 1, 1, 0]) });
  }
  if (rnd() < 0.7 && queued.length > 2)
    cmd({
      type: "setRankSuggestion",
      by: "agent",
      order: queued.filter(() => rnd() < 0.7).map((t) => ({ id: t.id, why: "x" })),
    });
  if (rnd() < 0.15) doc.useRankSuggestion = false;
  return doc;
}

/** `settleOnce` without the room: search, apply the best move, search again, up to 60. */
function settle(raw: any) {
  let doc = m.applyMigrations(structuredClone(raw));
  const moves: [string, number][] = [];
  for (let i = 0; i < 60 && doc.autoOrder === true; i++) {
    const best = m.suggestReorders(doc, { limit: 1, maxLane: Infinity }).suggestions[0];
    if (!best) break;
    moves.push([best.id, best.to]);
    doc = structuredClone(doc);
    applyCommand(doc, { type: "moveTaskInLane", id: best.id, toIndex: best.to, at: at(0) });
  }
  return { moves, final: createHash("sha256").update(JSON.stringify(doc)).digest("hex") };
}

const digest = (docs: any[]) => {
  const h = createHash("sha256");
  let moves = 0;
  for (const d of docs) {
    let out: unknown;
    try {
      const r = settle(d);
      moves += r.moves.length;
      out = r;
    } catch (e) {
      out = { error: (e as Error).message };
    }
    h.update(JSON.stringify(out) + "\n");
  }
  return { digest: h.digest("hex").slice(0, 16), moves };
};

// THE CLOCK IS PINNED: every search reads it again, as on the server, and here it does not move.
mock.timers.enable({ apis: ["Date"], now: NOW });
const small = Array.from({ length: 40 }, (_, i) =>
  plan(i + 1, 8 + Math.floor((i * 37) % 60), 4 + (i % 14), 1 + (i % 3 === 0 ? 1 : 0)),
);
const actual = {
  small: digest(small),
  large: digest([plan(9001, 673, 34)]),
};
mock.timers.reset();

if (process.env["SCHEDULE_MODULE"]) console.log(JSON.stringify(actual));

const EXPECTED = {
  small: { digest: "86460a690188b9cd", moves: 56 },
  large: { digest: "5a75eed0681fd531", moves: 21 },
};

await test("Given invented plans and a 673-task one-lane plan, when settled, then every move and the final plan match the code before the speed-up", () => {
  assert.deepEqual(actual, EXPECTED);
});
