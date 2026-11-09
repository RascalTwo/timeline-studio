// A PAGE THAT LOADED LESS MUST END UP WITH THE SAME PLAN AS A PAGE THAT LOADED EVERYTHING.
//
// Two clients join one real `CommandRoom`: one asks for the whole document (what every client did before), one is slim. A
// random sequence of commands runs against the room — text commands, moves, lane changes, finishing and reopening, adding
// and removing tasks, dependencies on finished work — interleaved with the slim client asking for text, for older work and
// for a search. Frames reach each client in the order the room sent them, one at a time, and the room answers the slim
// client's requests at random moments between commands, which is exactly what the socket's strictly-ordered handler does.
// When it is all delivered the slim client loads everything it is missing; the two documents must then be identical.
//
// The slim client is `Inbound` from shared/commands.ts, the code the page runs; this file supplies only the wire.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCommand,
  becomePartial,
  Inbound,
  missingOf,
  wholeIfComplete,
  type Command,
  type Doc,
  type Task,
} from "../../shared/commands.js";
import { CommandRoom, type ServerFrame, type Session } from "../src/room";
import { DAY, plan, rng } from "./slim-fixture";
import type { LoadRequest } from "../../shared/slim.js";

class Pipe implements Session {
  public readonly frames: ServerFrame[] = [];
  public cursor = 0;
  public readonly id: string;
  public constructor(id: string) {
    this.id = id;
  }
  // The wire: what is sent is a string, so nothing aliases the room's own document.
  public send(f: ServerFrame) {
    this.frames.push(JSON.parse(JSON.stringify(f)));
  }
  public close() {
    this.closed = true;
  }
  public closed = false;
  public next(): ServerFrame | undefined {
    return this.cursor < this.frames.length ? this.frames[this.cursor++] : undefined;
  }
  public get pending() {
    return this.frames.length - this.cursor;
  }
}

const seen = { applied: 0, skeleton: 0, text: 0, stalls: 0 };

function run(seed: number, steps: number) {
  const r = rng(seed);
  const now = Date.now();
  const room = new CommandRoom({
    id: "eq",
    doc: plan(seed, now, { n: 90, lanes: 1 + (seed % 3), text: { desc: 60, comments: 40 } }),
  });
  const fullPipe = new Pipe("full");
  const slimPipe = new Pipe("slim");
  room.join(fullPipe, { name: "f", color: "#000" });
  room.join(slimPipe, { name: "s", color: "#000" }, undefined, false, true);

  const first = (p: Pipe) => p.next() as Extract<ServerFrame, { type: "welcome" }>;
  const fw = first(fullPipe);
  const sw = first(slimPipe);
  const full: Doc = fw.doc;
  const slim: Doc = sw.doc;
  becomePartial(slim, sw.archived!);

  const outbox: LoadRequest[] = [];
  const inbound = new Inbound({
    doc: () => slim,
    send: (req) => {
      seen.stalls++;
      outbox.push(req);
    },
    applied: (_item, outcome) => {
      seen[outcome]++;
    },
    merged: () => {
      // nothing to do: the document is the state
    },
  });

  const deliver = (p: Pipe) => {
    const f = p.next();
    if (!f) return;
    if (f.type === "cmd") {
      if (p === fullPipe) applyCommand(full, f.cmd);
      else inbound.cmd({ seq: f.seq, cmd: f.cmd, by: f.by });
    } else if (f.type === "loaded") inbound.loaded(f);
  };
  const serve = () => {
    const req = outbox.shift();
    if (req) room.load(slimPipe, req);
  };

  let n = 0;
  const randomCommand = (): Command | null => {
    const doc = room.doc;
    const t = r.pick(doc.tasks);
    const open = doc.tasks.filter((x) => !x.done);
    switch (r.int(14)) {
      case 0:
        return { type: "setTaskDesc", id: t.id, desc: r.next() < 0.2 ? null : "new " + ++n };
      case 1:
      case 2:
        return {
          type: "addComment",
          id: t.id,
          comment: { id: "n" + ++n, text: "hello " + n, at: new Date().toISOString(), by: "p" },
        };
      case 3: {
        const c = t.comments?.[0];
        return c
          ? r.next() < 0.5
            ? { type: "editComment", id: t.id, commentId: c.id, text: "edited " + ++n }
            : { type: "removeComment", id: t.id, commentId: c.id }
          : null;
      }
      case 4:
        return { type: "renameTask", id: t.id, label: "renamed " + ++n };
      case 5:
        return {
          type: "moveTaskInLane",
          id: t.id,
          toIndex: r.int(doc.tasks.filter((x) => x.lane === t.lane).length),
        };
      case 6:
        return { type: "setTaskChannel", id: t.id, channel: "lane", value: r.pick(doc.lanes!).id };
      case 7:
        return t.done ? { type: "reopenTask", id: t.id } : { type: "finishTask", id: t.id };
      case 8: {
        const a = r.pick(open);
        return a
          ? { type: "addDep", id: a.id, dep: r.pick(doc.tasks.filter((x) => x.done)).id }
          : null;
      }
      case 9:
        return { type: "removeDep", id: t.id, dep: r.pick(t.deps.length > 0 ? t.deps : ["none"]) };
      case 10:
        return {
          type: "addTask",
          task: {
            id: "new" + ++n,
            label: "new",
            lane: r.pick(doc.lanes!).id,
            dur: 60,
            deps: r.next() < 0.5 ? [r.pick(doc.tasks).id] : [],
            desc: "born",
          },
        };
      case 11:
        return r.next() < 0.3
          ? { type: "removeTask", id: t.id }
          : { type: "setRefined", id: t.id, refinedAt: new Date().toISOString() };
      case 12:
        return { type: "setDuration", id: t.id, dur: 30 + r.int(100) };
      default:
        return {
          type: "setNotBefore",
          id: t.id,
          notBefore: new Date(now + r.int(10) * DAY).toISOString(),
        };
    }
  };

  const lazyIds = () => Object.keys(slim.partial!.lazy);
  for (let i = 0; i < steps; i++) {
    const dice = r.next();
    if (dice < 0.5) {
      const cmd = randomCommand();
      if (cmd) room.apply([cmd], "p");
    } else if (dice < 0.62) {
      const ids = lazyIds();
      if (ids.length > 0)
        outbox.push({
          ref: "t" + i,
          ids: [r.pick(ids), r.pick(ids)],
          text: true,
        });
    } else if (dice < 0.67) {
      outbox.push({
        since: new Date(now - r.int(120) * DAY).toISOString(),
        until: slim.partial!.before,
        deps: true,
      });
    } else if (dice < 0.85) serve();
    else {
      deliver(fullPipe);
      deliver(slimPipe);
    }
  }
  // Drain: deliver, serve and deliver again until nothing moves.
  const settle = () => {
    for (
      let guard = 0;
      guard < 10_000 && (fullPipe.pending > 0 || slimPipe.pending > 0 || outbox.length > 0);
      guard++
    ) {
      deliver(fullPipe);
      deliver(slimPipe);
      serve();
    }
  };
  settle();
  // Hydrate: everything older, then every text.
  outbox.push({ since: null, deps: true });
  settle();
  for (let guard = 0; guard < 100 && missingOf(slim).text > 0; guard++) {
    outbox.push({ ids: lazyIds().slice(0, 50), text: true });
    settle();
  }
  return { room, full, slim, inbound };
}

const strip = (d: Doc): Doc => JSON.parse(JSON.stringify(d));

await test("Given random commands and random lazy loads, when everything is loaded, then the slim client holds the same plan", () => {
  let waited = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const { room, full, slim, inbound } = run(seed, 220);
    assert.ok(!inbound.waiting, `seed ${seed}: still waiting for a reply`);
    assert.equal(
      wholeIfComplete(slim),
      true,
      `seed ${seed}: ${JSON.stringify(missingOf(slim))} still missing`,
    );
    assert.deepEqual(strip(slim), strip(full), `seed ${seed}: slim and full documents differ`);
    assert.deepEqual(
      strip(full),
      strip(room.doc),
      `seed ${seed}: the full client drifted from the room`,
    );
    waited += 1;
  }
  assert.equal(waited, 150);
  // the run means something only if it reached the hard paths
  assert.ok(seen.skeleton > 100 && seen.text > 100 && seen.stalls > 20, JSON.stringify(seen));
});

await test("Given the same run, then a slim client that never loads anything still orders its tasks as the room does", () => {
  for (let seed = 100; seed < 120; seed++) {
    const { slim, room } = run(seed, 150);
    // everything it holds, in the room's order
    const order = new Map(room.doc.tasks.map((t: Task, i: number) => [t.id, i]));
    const held = slim.tasks.map((t) => order.get(t.id)!);
    assert.deepEqual(
      held,
      held.toSorted((a, b) => a - b),
    );
  }
});
