// A PLAN SHAPED LIKE A REAL PERSONAL ONE, invented: one or a few long lanes, most of it finished a long time ago, chains of
// finished work behind open work, paused and running work, text on nearly everything. Shared by the slim tests.
import type { Doc, Task } from "../../shared/commands.js";
import { SCHEMA } from "../../shared/schedule.js";

export const DAY = 86_400_000;

/** A seeded generator, so a failing seed can be replayed. */
export const rng = (seed: number) => {
  let s = seed * 7919 + 13;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  return {
    next,
    pick: <T>(a: readonly T[]) => a[Math.floor(next() * a.length)]!,
    int: (n: number) => Math.floor(next() * n),
  };
};

export interface FixtureOptions {
  n: number;
  lanes?: number;
  milestones?: boolean;
  /** Characters of description per task, and comments per task, at most. */
  text?: { desc: number; comments: number };
}

export function plan(seed: number, now: number, o: FixtureOptions): Doc {
  const r = rng(seed);
  const laneIds = Array.from({ length: o.lanes ?? 2 }, (_, i) => "L" + i);
  const at = (days: number) => new Date(now + days * DAY).toISOString();
  const tasks: Task[] = [];
  for (let i = 0; i < o.n; i++) {
    const kind = r.next();
    const t: Task = {
      id: "t" + i,
      label: "task " + i,
      lane: r.pick(laneIds),
      createdAt: at(-200 + i / 10),
      border: "b1",
      fill: "f1",
      shape: "s1",
      color: [],
      dur: r.pick([15, 30, 60, 120, 480]),
      deps: [],
    };
    // Dependencies point at earlier tasks only, so there is never a cycle.
    const ndeps = i > 0 ? r.pick([0, 0, 1, 1, 2]) : 0;
    for (let k = 0; k < ndeps; k++) {
      const d = "t" + r.int(i);
      if (!t.deps.includes(d)) t.deps.push(d);
    }
    if (kind < 0.55) {
      // finished: long ago, mostly; some within a fortnight; a few finishing later today
      const age = r.pick([200, 120, 60, 30, 16, 15, 13, 5, 1, -0.2]);
      const stop = now - age * DAY;
      t.done = true;
      t.sessions = [
        { start: new Date(stop - 3_600_000).toISOString(), stop: new Date(stop).toISOString() },
      ];
    } else if (kind < 0.62) {
      t.sessions = [{ start: at(-1), stop: at(-0.9) }];
    }
    const txt = o.text;
    if (txt) {
      if (r.next() < 0.9) t.desc = "d".repeat(1 + r.int(txt.desc));
      const nc = r.int(3);
      if (nc > 0 && txt.comments > 0)
        t.comments = Array.from({ length: nc }, (_, k) => ({
          id: `c${i}-${k}`,
          text: "c".repeat(1 + r.int(txt.comments)),
          at: at(-3),
          by: "someone",
        }));
    }
    if (o.milestones && r.next() < 0.3) t.ms = r.pick(["m1", "m2"]);
    tasks.push(t);
  }
  return {
    schemaVersion: SCHEMA,
    title: "Slim fixture",
    start: at(-300).slice(0, 10),
    timeZone: "America/Chicago",
    lanes: laneIds.map((id) => ({ id, label: id })),
    borders: [{ id: "b1", label: "prod", style: "solid" }],
    fills: [{ id: "f1", label: "known", pattern: "solid" }],
    shapes: [{ id: "s1", label: "none", shape: "soft" }],
    colors: [],
    milestones: o.milestones
      ? [
          { id: "m1", label: "m1", date: at(10).slice(0, 10) },
          { id: "m2", label: "m2", date: at(40).slice(0, 10) },
        ]
      : [],
    tasks,
  };
}
