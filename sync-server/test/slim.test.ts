// THE SLIM PROJECTION: what it keeps, that keeping it changes no answer, and that the text stays out.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { deflateSync } from "node:zlib";
import type { Doc } from "../../shared/commands.js";
import { readiness, verdict } from "../../shared/schedule.js";
import {
  keepSet,
  loadReply,
  slimDoc,
  textOf,
  withoutText,
  WINDOW_DAYS,
} from "../../shared/slim.js";
import { CommandRoom, type ServerFrame, type Session } from "../src/room";
import { DAY, plan } from "./slim-fixture";

const NOW = Date.parse("2026-11-08T15:00:00.000Z");

const prune = (doc: Doc, now = NOW) => {
  const { keep } = keepSet(doc, now);
  return { ...doc, tasks: doc.tasks.filter((t) => keep.has(t.id)) };
};

/** Run `f` with the clock frozen: two runs on one document are then byte-identical, which is what makes "the same rows" a claim. */
const frozen = <T>(f: () => T): T => {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    return f();
  } finally {
    mock.timers.reset();
  }
};

await test("Given random plans, when old finished work is pruned, then every open task's readiness row is unchanged", () => {
  let dropped = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const full = plan(seed, NOW, { n: 120, lanes: 1 + (seed % 3) });
    const pruned = prune(full);
    dropped += full.tasks.length - pruned.tasks.length;
    const [a, b] = frozen(() => [readiness(full), readiness(pruned)]);
    const open = new Set(full.tasks.filter((t) => !t.done).map((t) => t.id));
    const rows = (rs: typeof a) => rs.filter((r) => open.has(r.id));
    assert.deepEqual(rows(b), rows(a), `seed ${seed}: an open task's row moved`);
  }
  assert.ok(dropped > 500, "the property is vacuous if nothing is ever pruned");
});

await test("Given a chain of finished work behind an open task, then the whole chain stays, and only the rest goes", () => {
  const full = plan(1, NOW, { n: 0 });
  const done = (id: string, deps: string[], days: number) => ({
    id,
    label: id,
    lane: "L0",
    createdAt: "2026-01-01T00:00:00.000Z",
    border: "b1",
    fill: "f1",
    shape: "s1",
    color: [],
    dur: 60,
    deps,
    done: true as const,
    sessions: [
      {
        start: new Date(NOW - days * DAY - 3_600_000).toISOString(),
        stop: new Date(NOW - days * DAY).toISOString(),
      },
    ],
  });
  full.tasks = [
    done("old-root", [], 300),
    done("old-mid", ["old-root"], 290),
    done("old-leaf", ["old-mid"], 280),
    done("old-alone", [], 270),
    done("fortnight", [], WINDOW_DAYS - 1),
    done("too-old", [], WINDOW_DAYS + 1),
    done("later", [], -1),
    { ...done("todo", ["old-leaf"], 0), done: undefined, sessions: undefined } as never,
  ];
  const { keep } = keepSet(full, NOW);
  assert.deepEqual([...keep].toSorted(), [
    "fortnight",
    "later",
    "old-leaf",
    "old-mid",
    "old-root",
    "todo",
  ]);
  const [a, b] = frozen(() => [readiness(full), readiness(prune(full))]);
  assert.deepEqual(
    b.find((r) => r.id === "todo"),
    a.find((r) => r.id === "todo"),
  );
});

await test("Given a plan with milestones, then nothing is pruned and the verdict is the same", () => {
  const full = plan(5, NOW, { n: 80, milestones: true });
  assert.equal(prune(full).tasks.length, full.tasks.length);
  const [a, b] = frozen(() => [verdict(full), verdict(prune(full))]);
  assert.deepEqual(b, a);
});

await test("Given finished work kept for a dependency, its own dependencies stay too", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { keep } = keepSet(plan(seed, NOW, { n: 150 }), NOW);
    const full = plan(seed, NOW, { n: 150 });
    for (const t of full.tasks) if (keep.has(t.id)) for (const d of t.deps) assert.ok(keep.has(d));
  }
});

await test("Given a slim document, then no task has text and the archive says where the rest sit", () => {
  const full = plan(3, NOW, { n: 200, lanes: 2, text: { desc: 400, comments: 300 } });
  const { doc, archived } = slimDoc(full, NOW);
  for (const t of doc.tasks) {
    assert.ok(!("desc" in t) && !("comments" in t));
  }
  assert.equal(archived.count, full.tasks.length - doc.tasks.length);
  assert.ok(archived.count > 0);
  assert.deepEqual(
    archived.ids,
    full.tasks.map((t) => t.id),
  );
  assert.deepEqual(
    Object.keys(archived.lanes).toSorted(),
    full.tasks
      .filter((t) => !doc.tasks.some((x) => x.id === t.id))
      .map((t) => t.id)
      .toSorted(),
  );
  // the room's own tasks are untouched
  assert.ok(full.tasks.some((t) => t.desc));
  assert.ok(!("desc" in withoutText(full.tasks.find((t) => t.desc)!)));
});

await test("Given a plan the size of a real one, then the slim welcome stays small and text cannot creep back in", () => {
  const full = plan(9, Date.now(), { n: 1300, lanes: 1, text: { desc: 3600, comments: 2400 } });
  const room = new CommandRoom({ id: "p", doc: full });
  const frames: ServerFrame[] = [];
  const s: Session = {
    id: "s",
    send: (f) => {
      frames.push(f);
    },
    close: () => {
      throw new Error("not closed in this test");
    },
  };
  room.join(s, { name: "x", color: "#000" }, undefined, false, true);
  const wire = JSON.stringify(frames[0]);
  const whole = JSON.stringify({ doc: full });
  assert.ok(whole.length > 3_000_000, `the fixture must carry real volume, got ${whole.length}`);
  // The bytes the budget is about: the real plan's slim welcome is about 480 KB raw and 82-109 KB deflated.
  assert.ok(
    wire.length < whole.length * 0.12,
    `slim welcome is ${wire.length} of ${whole.length} bytes`,
  );
  assert.ok(wire.length < 450_000, `slim welcome is ${wire.length} bytes raw`);
  const gz = deflateSync(wire).length;
  assert.ok(gz < 150_000, `deflated slim welcome is ${gz} bytes`);
  assert.ok(
    !wire.includes('"desc"') && !wire.includes('"comments"'),
    "text is back in the welcome",
  );
});

await test("Given load requests, then each selects what it says and the reply carries what was asked", () => {
  const full = plan(4, NOW, { n: 150, text: { desc: 50, comments: 50 } });
  const byId = new Map(full.tasks.map((t) => [t.id, t]));
  const withText = loadReply(full, { ids: ["t3", "nope"], text: true }, 7);
  assert.equal(withText.seq, 7);
  assert.deepEqual(withText.gone, ["nope"]);
  assert.deepEqual(withText.text, ["t3"]);
  assert.equal(withText.tasks[0]!.desc, byId.get("t3")!.desc);
  const bare = loadReply(full, { ids: ["t3"] }, 7);
  assert.ok(!("desc" in bare.tasks[0]!) && bare.text.length === 0);
  // closure: asking for a task brings what it waits on, without text
  const dep = full.tasks.find((t) => t.deps.length > 0)!;
  const closure = loadReply(full, { ids: [dep.id], text: true, deps: true }, 1);
  assert.ok(closure.tasks.length > 1);
  for (const d of dep.deps) assert.ok(closure.tasks.some((t) => t.id === d));
  assert.deepEqual(closure.text, [dep.id]);
  // a range of finished work
  const range = loadReply(full, { since: null, until: new Date(NOW - 100 * DAY).toISOString() }, 1);
  assert.ok(range.tasks.length > 0 && range.tasks.every((t) => t.done));
  // what the REST text read returns
  const withDesc = full.tasks.find((t) => t.desc)!;
  assert.deepEqual(textOf(withDesc), {
    id: withDesc.id,
    desc: withDesc.desc,
    comments: withDesc.comments ?? [],
  });
  assert.deepEqual(
    textOf({ ...withDesc, desc: undefined as never, comments: undefined as never }),
    {
      id: withDesc.id,
      desc: null,
      comments: [],
    },
  );
});
