// A DEPLOY MUST NOT DROP AN EDIT. ECS stops the old task with SIGTERM, and a
// draft is written 3s after its last edit, so an edit made in that window used
// to die with the process. This boots the real server as a child, the way the
// image runs it (`tsx src/server.ts`, so tsx's signal relay is in the path too),
// edits a plan over the socket, and stops it inside the debounce window.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";
import { WebSocket } from "ws";
import { type FakeS3, startFakeS3 } from "./fake-s3";

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

/** Boots the server, makes one edit over the socket, and stops it with SIGTERM while
 *  the edit is still waiting on the save delay. `beforeStop` runs just before the signal. */
const editThenStop = async (beforeStop?: (fake: FakeS3) => void) => {
  const fake = await startFakeS3("shutdown-test");
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn("node_modules/.bin/tsx", ["src/server.ts"], {
    env: {
      ...process.env,
      DATA_BUCKET: "shutdown-test",
      S3_ENDPOINT: fake.endpoint,
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
  });
  try {
    for (let i = 0; i < 200; i++) {
      if (
        await fetch(`${BASE}/health`).then(
          (r) => r.ok,
          () => false,
        )
      )
        break;
      await sleep(50);
    }
    const made = (await (
      await fetch(`${BASE}/api/plan/new`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-timeline-by": "tester" },
        body: JSON.stringify({ title: "Shutdown test" }),
      })
    ).json()) as { shareToken: string; id: string };

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/connect`);
    const frames: { type: string }[] = [];
    ws.on("message", (m: Buffer) => {
      frames.push(JSON.parse(m.toString()) as { type: string });
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        resolve();
      });
      ws.on("error", reject);
    });
    const next = async (type: string) => {
      for (let i = 0; i < 200 && !frames.some((f) => f.type === type); i++) await sleep(25);
      assert.ok(
        frames.some((f) => f.type === type),
        `no ${type} frame`,
      );
    };
    ws.send(JSON.stringify({ type: "hello", token: made.shareToken, name: "Ann" }));
    await next("welcome");
    const draftKey = `data/${made.id}.json`;
    const before = fake.objects.get(draftKey);
    assert.ok(before, "the plan's draft exists");
    ws.send(
      JSON.stringify({
        type: "cmd",
        ref: "r1",
        cmd: {
          type: "addTask",
          task: {
            id: "t-shutdown",
            label: "Edited just before a deploy",
            lane: "L1",
            createdAt: "2026-10-01T09:00:00.000Z",
            border: "b1",
            fill: "known",
            shape: "s1",
            color: [],
            dur: 3,
            deps: [],
          },
        },
      }),
    );
    await next("cmd");
    assert.ok(!frames.some((f) => f.type === "rejected"), "the edit was accepted");
    assert.equal(
      fake.objects.get(draftKey),
      before,
      "premise: the edit is still waiting on the 3s save delay",
    );

    beforeStop?.(fake);
    child.kill("SIGTERM");
    const code = await exited;
    fake.down = false;
    ws.terminate();
    return { code, draft: fake.objects.get(draftKey) ?? "", stderr };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await fake.close();
  }
};

await test("Given an edit still inside the save delay, when the server gets SIGTERM, then the draft is written before it exits", async () => {
  const { code, draft } = await editThenStop();
  assert.equal(code, 0, "a clean exit once everything is written");
  assert.match(draft, /t-shutdown/u, "the edit reached the bucket before the process died");
});

await test("Given the store is down at shutdown, when the server gets SIGTERM, then it says so and exits non-zero", async () => {
  const { code, draft, stderr } = await editThenStop((fake) => {
    fake.down = true;
  });
  assert.equal(code, 1, "a write that failed is not a clean exit");
  assert.doesNotMatch(draft, /t-shutdown/u);
  assert.match(stderr, /1 open plan\(s\) could not be written/u);
});
