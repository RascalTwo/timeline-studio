// THE IDLE MONITOR, with no AWS. `startIdleShutdown` reads ECS_CLUSTER and IDLE_SHUTDOWN_MINUTES at import,
// so each scenario imports its own copy of the module (the query string makes a new instance) with the
// environment it wants, drives the one-minute interval with mock timers, and replaces `ECSClient.send` so
// nothing leaves the process. What is asserted is the one property that costs money when it is wrong: the
// service is scaled to zero only after the room set has been EMPTY for the whole window, and a failure
// leaves it running.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ECSClient, ListServicesCommand, UpdateServiceCommand } from "@aws-sdk/client-ecs";

type Sent = { kind: string; input: Record<string, unknown> };

async function scenario(env: Record<string, string | undefined>, tag: string) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  const { startIdleShutdown } = (await import(
    `../src/idle-shutdown.ts?${tag}`
  )) as typeof import("../src/idle-shutdown");
  return startIdleShutdown;
}

const flush = async () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const minute = async (n = 1) => {
  for (let i = 0; i < n; i++) {
    mock.timers.tick(60_000);
    // the tick starts an async check; let its promises settle
    await flush();
    await flush();
  }
};

await test("Given no ECS_CLUSTER, when the monitor starts, then it is disabled and starts no timer", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const log = mock.method(console, "log", () => {
    // silenced: the expected noise of the scenario under test
  });
  try {
    const start = await scenario(
      { ECS_CLUSTER: undefined, IDLE_SHUTDOWN_MINUTES: undefined },
      "off",
    );
    let polled = 0;
    start(() => ++polled);
    await minute(3);
    assert.equal(polled, 0, "a disabled monitor never asks for the room count");
    assert.match(String(log.mock.calls[0]?.arguments[0]), /idle shutdown disabled/u);
  } finally {
    log.mock.restore();
    mock.timers.reset();
  }
});

await test("Given a cluster, when rooms are open or the window has not elapsed, then nothing is scaled; when it has, the one service goes to zero", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const sent: Sent[] = [];
  const seen = () => [...sent];
  const send = mock.method(ECSClient.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof ListServicesCommand) {
      sent.push({ kind: "list", input: cmd.input as unknown as Record<string, unknown> });
      return { serviceArns: ["arn:svc/one"] };
    }
    sent.push({
      kind: "update",
      input: (cmd as UpdateServiceCommand).input as unknown as Record<string, unknown>,
    });
    return {};
  });
  const log = mock.method(console, "log", () => {
    // silenced: the expected noise of the scenario under test
  });
  try {
    const start = await scenario({ ECS_CLUSTER: "c1", IDLE_SHUTDOWN_MINUTES: "3" }, "on");
    let open = 1;
    start(() => open);
    await minute(5);
    assert.deepEqual(seen(), [], "open rooms keep the service up however long it has run");
    open = 0;
    await minute(2);
    assert.deepEqual(seen(), [], "two empty minutes of a three-minute window");
    open = 1;
    await minute(1);
    open = 0;
    await minute(2);
    assert.deepEqual(seen(), [], "a room opening resets the count");
    await minute(1);
    assert.deepEqual(
      seen().map((s) => s.kind),
      ["list", "update"],
    );
    assert.deepEqual(seen()[0]?.input, { cluster: "c1" });
    assert.deepEqual(seen()[1]?.input, { cluster: "c1", service: "arn:svc/one", desiredCount: 0 });
    assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /scaled service to 0/u);
  } finally {
    log.mock.restore();
    send.mock.restore();
    mock.timers.reset();
  }
});

await test("Given the cluster has no service or ECS fails, when the window has elapsed, then it stays up and retries on the next tick", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  let mode: "none" | "fail" = "none";
  let updates = 0;
  const send = mock.method(ECSClient.prototype, "send", async (cmd: unknown) => {
    if (cmd instanceof ListServicesCommand) {
      if (mode === "fail") throw new Error("throttled");
      return { serviceArns: [] };
    }
    updates++;
    return {};
  });
  const err = mock.method(console, "error", () => {
    // silenced: the expected noise of the scenario under test
  });
  try {
    const start = await scenario({ ECS_CLUSTER: "c2", IDLE_SHUTDOWN_MINUTES: "1" }, "fail");
    start(() => 0);
    await minute(2);
    assert.equal(updates, 0, "no service listed, nothing to scale");
    mode = "fail";
    await minute(1);
    assert.match(String(err.mock.calls[0]?.arguments[0]), /failed to scale service to zero/u);
    await minute(1);
    assert.equal(
      err.mock.calls.length,
      2,
      "it tried again on the very next tick rather than waiting a window",
    );
    assert.equal(updates, 0);
  } finally {
    err.mock.restore();
    send.mock.restore();
    mock.timers.reset();
  }
});

await test("Given the room count itself throws, when the tick fires, then it is logged and the timer keeps running", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const err = mock.method(console, "error", () => {
    // silenced: the expected noise of the scenario under test
  });
  try {
    const start = await scenario({ ECS_CLUSTER: "c3", IDLE_SHUTDOWN_MINUTES: "60" }, "throws");
    let calls = 0;
    start(() => {
      calls++;
      throw new Error("rooms gone");
    });
    await minute(2);
    assert.equal(calls, 2);
    assert.match(String(err.mock.calls[0]?.arguments[0]), /check failed/u);
  } finally {
    err.mock.restore();
    mock.timers.reset();
  }
});
