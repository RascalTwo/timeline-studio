// THE REAL `server.ts`, BOOTED. Until this file nothing in the gate loaded it: the routes were checked
// against the OpenAPI spec by READING the source (openapi.test.ts) and the room by a fake session
// (room.test.ts), so the handlers themselves — token resolution, the ctx() wrapper, the error paths,
// the socket's frame loop — ran only in production. It listens on import, so the environment is set
// first and the import is dynamic; the store is `fake-s3.ts` (S3_ENDPOINT is how s3.ts reaches Versity
// on the NAS), so no storage and no network beyond loopback is touched.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mock, test } from "node:test";
import { WebSocket } from "ws";
import { startFakeS3 } from "./fake-s3";

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const freePort = async () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => {
        resolve(port);
      });
    });
  });

const fake = await startFakeS3("server-test");
const PORT = await freePort();
process.env["DATA_BUCKET"] = "server-test";
process.env["S3_ENDPOINT"] = fake.endpoint;
process.env["PORT"] = String(PORT);
const { app } = await import("../src/server");
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++) {
  if (
    await fetch(`${BASE}/health`).then(
      (r) => r.ok,
      () => false,
    )
  )
    break;
  await sleep(50);
}

type Json = Record<string, unknown>;
const call = async (method: string, path: string, token?: string, body?: unknown, by?: string) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { "x-timeline-token": token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(by ? { "x-timeline-by": by } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {
    // not JSON: the caller reads `text`
  }
  return { status: res.status, json, text, headers: res.headers };
};

const made = await call("POST", "/api/plan/new", undefined, { title: "Server test" }, "tester");
const token = made.json["shareToken"] as string;
const newTask = {
  id: "t1",
  label: "First",
  lane: "L1",
  createdAt: "2026-10-01T09:00:00.000Z",
  border: "b1",
  fill: "known",
  shape: "s1",
  color: [],
  dur: 3,
  deps: [],
};

await test("Given the server, when liveness and the static references are asked for, then each answers", async () => {
  for (const p of ["/health", "/api/health"]) {
    const r = await call("GET", p);
    assert.equal(r.status, 200);
    assert.equal(r.json["ok"], true);
  }
  assert.match((await call("GET", "/commands.js")).text, /export/u);
  assert.match((await call("GET", "/AGENTS.md")).headers.get("content-type") ?? "", /markdown/u);
  assert.equal((await call("GET", "/llms.txt")).status, 200);
  assert.equal((await call("GET", "/api/rooms")).json["openRooms"], 0);
  const spec = await call("GET", "/api/openapi.json");
  assert.equal(spec.headers.get("cache-control"), "public, max-age=86400");
  assert.ok(spec.json["paths"]);
  assert.match((await call("GET", "/api/docs")).text, /Scalar/u);
});

await test("Given a store that answers, when readiness is asked for, then 200; when it is down, 503 and the HTTP error handler stays quiet about it", async () => {
  assert.equal((await call("GET", "/api/readyz")).status, 200);
  const quiet = mock.method(console, "error", () => {
    // silenced: the expected noise of the scenario under test
  });
  fake.down = true;
  try {
    const r = await call("GET", "/api/readyz");
    assert.equal(r.status, 503);
    assert.equal(r.json["store"], "unreachable");
    const plan = await call("GET", "/api/plan", token);
    assert.equal(plan.status, 503, "a dead store is a 503, not a 400 about the token");
    assert.equal(plan.json["error"], "the plan store is unavailable");
  } finally {
    fake.down = false;
    quiet.mock.restore();
  }
});

await test("Given New, when a plan is created, then the token is in the body only and the plan reads back", async () => {
  assert.equal(made.status, 200);
  assert.equal(made.headers.get("cache-control"), "no-store");
  assert.match(token, /^[A-Za-z0-9_-]{22}$/u);
  const plan = await call("GET", "/api/plan", token);
  assert.equal(plan.status, 200);
  assert.equal(plan.json["viewers"], 0);
  assert.equal((plan.json["doc"] as Json)["title"], "Server test");
  const bad = await call("POST", "/api/plan/new", undefined, { doc: { nonsense: true } });
  assert.equal(bad.status, 400);
  assert.equal((await call("GET", "/api/plan", "not-a-token")).status, 404);
  assert.equal((await call("GET", "/api/plan")).status, 404);
  assert.equal(
    (await call("GET", "/api/rooms")).json["openRooms"],
    0,
    "an HTTP call closes its room",
  );
});

await test("Given commands, when they are posted, then valid ones apply and the rest are refused with the validator's words", async () => {
  assert.equal((await call("POST", "/api/commands", token, {})).status, 400);
  assert.equal((await call("POST", "/api/commands", token, { cmds: [] })).status, 400);
  const bad = await call("POST", "/api/commands", token, {
    cmd: { type: "renameTask", id: "nope", label: "x" },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.json["error"]);
  const ok = await call(
    "POST",
    "/api/commands?settle=1",
    token,
    { cmd: { type: "addTask", task: newTask } },
    "agent-x",
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.json["applied"], 1);
  const batch = await call("POST", "/api/commands", token, {
    cmds: [
      { type: "renameTask", id: "t1", label: "Renamed" },
      { type: "setDuration", id: "t1", dur: 4 },
    ],
  });
  assert.equal(batch.json["applied"], 2);
  const plan = await call("GET", "/api/plan?settle=1", token);
  const tasks = (plan.json["doc"] as { tasks: { id: string; label: string; dur: number }[] }).tasks;
  assert.deepEqual(
    tasks.map((t) => [t.id, t.label, t.dur]),
    [["t1", "Renamed", 4]],
  );
});

await test("Given the schedule readers, when asked for the live plan or a posted one, then each answers and none leaves a room open", async () => {
  for (const p of ["/api/ready", "/api/verdict", "/api/reorder?limit=2&maxLane=5"]) {
    const live = await call("GET", p, token);
    assert.equal(live.status, 200, `${p}: ${live.text.slice(0, 200)}`);
  }
  const doc = (await call("GET", "/api/plan", token)).json["doc"] as Json;
  for (const p of ["/api/ready?all=1", "/api/verdict", "/api/reorder"]) {
    const posted = await call("POST", p, token, { doc });
    assert.equal(posted.status, 200, `${p}: ${posted.text.slice(0, 200)}`);
  }
  const cycle = structuredClone(doc) as { tasks: Json[] };
  cycle.tasks = [
    { ...newTask, id: "a", deps: ["b"] },
    { ...newTask, id: "b", deps: ["a"] },
  ];
  const r = await call("POST", "/api/verdict", token, { doc: cycle });
  assert.ok(r.status >= 400, "a cycle is an error across the wire too");
  for (const p of ["/api/ready", "/api/verdict", "/api/reorder"])
    assert.equal((await call("GET", p, "nope")).status, 404);
  assert.equal((await call("GET", "/api/rooms")).json["openRooms"], 0);
});

await test("Given the archive, when saved, listed, read, annotated and reverted, then each step does what it says", async () => {
  const saved = await call("POST", "/api/save", token, { note: "first save" }, "tester");
  assert.equal(saved.status, 200);
  const all = await call("GET", "/api/history", token);
  const versions = all.json["versions"] as { n: number; note: string; doc?: unknown }[];
  assert.ok(versions.length >= 2, "version 1 from New, then this save");
  const meta = (await call("GET", "/api/history?meta=1", token)).json["versions"] as {
    doc?: unknown;
  }[];
  assert.ok(meta.every((v) => v.doc === undefined));
  const last = (await call("GET", "/api/history?last=1", token)).json["versions"] as {
    note: string;
  }[];
  assert.equal(last.length, 1);
  assert.equal(last[0]?.note, "first save");

  const n = versions[0]?.n ?? 1;
  assert.equal((await call("GET", `/api/version?n=${n}`, token)).status, 200);
  assert.equal((await call("GET", "/api/version?n=0", token)).status, 400);
  assert.equal((await call("GET", "/api/version?n=999", token)).status, 404);

  assert.equal(
    (await call("POST", "/api/histnote", token, { n, note: "renamed note" })).status,
    200,
  );
  assert.equal((await call("GET", `/api/version?n=${n}`, token)).json["note"], "renamed note");
  assert.equal((await call("POST", "/api/histnote", token, { n: 0 })).status, 400);
  assert.equal((await call("POST", "/api/histnote", token, { n: 999 })).status, 404);

  assert.equal((await call("POST", "/api/revert", token, { n: 0 })).status, 400);
  const rev = await call("POST", "/api/revert", token, { n });
  assert.equal(rev.status, 200, rev.text);
  assert.equal(rev.json["from"], n);
  const tasks = ((await call("GET", "/api/plan", token)).json["doc"] as { tasks: unknown[] }).tasks;
  assert.equal(tasks.length, 0, "version 1 is the empty starter");
  assert.equal((await call("POST", "/api/revert", token, { n: 999 })).status, 400);
});

/** The viewer count once it settles on `want`: a closed socket leaves the room a moment after it closes. */
const viewers = async (want: number) => {
  let got = -1;
  for (let i = 0; i < 100 && got !== want; i++) {
    got = (await call("GET", "/api/plan", token)).json["viewers"] as number;
    if (got !== want) await sleep(25);
  }
  return got;
};

/** One socket, its frames collected, with a way to wait for the next one of a type. */
const connect = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/connect`);
  const frames: Json[] = [];
  ws.on("message", (m: Buffer) => {
    frames.push(JSON.parse(m.toString()) as Json);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => {
      resolve();
    });
    ws.on("error", reject);
  });
  const used = new Set<Json>();
  const next = async (type: string) => {
    for (let i = 0; i < 200; i++) {
      const hit = frames.find((f) => f["type"] === type && !used.has(f));
      if (hit) {
        used.add(hit);
        return hit;
      }
      await sleep(25);
    }
    throw new Error(`no ${type} frame; got ${JSON.stringify(frames.map((f) => f["type"]))}`);
  };
  const closed = new Promise<void>((resolve) => {
    ws.on("close", () => {
      resolve();
    });
  });
  return {
    ws,
    frames,
    next,
    send: (f: unknown) => {
      ws.send(JSON.stringify(f));
    },
    closed,
  };
};

await test("Given the socket, when frames arrive out of order or malformed, then each is answered and none kills the connection", async () => {
  const c = await connect();
  c.ws.send("not json");
  assert.equal((await c.next("error"))["error"], "frames must be JSON");
  c.send({ type: "cmd", cmd: { type: "renameTask", id: "t1", label: "x" } });
  assert.equal((await c.next("error"))["error"], "send hello first");
  c.send({ type: "hello", token, name: "Ann", color: "#fff" });
  const welcome = await c.next("welcome");
  assert.ok(welcome["doc"]);
  c.send({ type: "hello", token });
  assert.equal((await c.next("error"))["error"], "already joined");
  c.send({ type: "mystery" });
  assert.equal((await c.next("error"))["error"], "unknown frame");
  c.ws.close();
  await c.closed;
});

await test("Given two sockets on one plan, when one edits, saves and reverts, then the other sees it", async () => {
  const a = await connect();
  const b = await connect();
  a.send({ type: "hello", token, name: "Ann" });
  b.send({ type: "hello", token, name: "Bob", lurk: false });
  await a.next("welcome");
  await b.next("welcome");
  assert.equal(await viewers(2), 2);

  a.send({ type: "presence", name: "Annie", cursor: { day: 1, laneRow: 0 } });
  await b.next("presence");

  a.send({ type: "cmd", ref: "r1", cmd: { type: "addTask", task: newTask } });
  const echo = await a.next("cmd");
  assert.equal(echo["ref"], "r1");
  await b.next("cmd");
  a.send({ type: "cmd", ref: "r2", cmd: { type: "renameTask", id: "missing", label: "x" } });
  assert.equal((await a.next("rejected"))["ref"], "r2");

  a.send({ type: "save", ref: "s1", note: "from the socket" });
  assert.equal((await a.next("saved"))["ref"], "s1");
  await b.next("saved");

  b.send({ type: "revert", n: 1 });
  await a.next("reverted");

  b.ws.close();
  await b.closed;
  await a.next("left");
  a.ws.close();
  await a.closed;

  const bad = await connect();
  bad.send({ type: "hello", token: "nope" });
  assert.equal((await bad.next("error"))["error"], "no such plan");
  await bad.closed;

  const lurker = await connect();
  lurker.send({ type: "hello", token, lurk: true });
  await lurker.next("welcome");
  assert.equal(await viewers(0), 0, "a lurker is not a viewer");
  lurker.ws.close();
  await lurker.closed;
});

await test("Given a store that dies mid-session, when a socket says hello, then it is told the store is unavailable", async () => {
  // A fresh plan, so no room is loaded for it yet and `hello` has to read from the dead store.
  const other = await call("POST", "/api/plan/new", undefined, { title: "Other" });
  const t2 = other.json["shareToken"] as string;
  // Drop the token cache by using a token the server has not resolved: mint, then break the store.
  const c = await connect();
  const quiet = mock.method(console, "error", () => {
    // silenced: the expected noise of the scenario under test
  });
  fake.down = true;
  try {
    c.send({ type: "hello", token: t2 });
    const err = await c.next("error");
    assert.equal(err["error"], "the plan store is unavailable");
  } finally {
    fake.down = false;
    quiet.mock.restore();
  }
  c.ws.close();
  await c.closed;
});

await test("Given the whole server, when the suite is done, then it closes and leaves no room open", async () => {
  assert.equal((await call("GET", "/api/rooms")).json["openRooms"], 0);
  await app.close();
  await fake.close();
});
