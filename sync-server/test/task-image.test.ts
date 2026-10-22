// A TASK'S ONE PICTURE. `image` is painted as an `<img src>` in every viewer's browser, so like `url`
// it is an allowlist at the door: a hosted http(s) picture or one inlined as a raster base64 data URI.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, validateCommand, type Doc } from "../../shared/commands.js";
import { SCHEMA } from "../../shared/schedule.js";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const plan = (): Doc => ({
  schemaVersion: SCHEMA,
  title: "x",
  start: "2026-09-21",
  timeZone: "UTC",
  lanes: [{ id: "me", label: "me" }],
  borders: [{ id: "b", label: "b" }],
  fills: [{ id: "f", label: "f" }],
  shapes: [{ id: "s", label: "s" }],
  colors: [],
  milestones: [],
  tasks: [
    {
      id: "t",
      label: "t",
      lane: "me",
      border: "b",
      fill: "f",
      shape: "s",
      color: [],
      deps: [],
      dur: 60,
      refinedAt: "2026-09-20T00:00:00.000Z",
    },
  ],
});

const set = (image: unknown) => validateCommand(plan(), { type: "setTaskImage", id: "t", image });
const add = (image: unknown) =>
  validateCommand(plan(), { type: "addTask", task: { id: "n", label: "n", dur: 30, image } });

const GOOD = ["https://example.com/a.jpg", "http://example.com/a.png", PNG];
const BAD: [unknown, RegExp][] = [
  ["javascript:alert(1)", /http:\/\/ or https:\/\//u],
  ["data:text/html;base64,PHNjcmlwdD4=", /data:image\/png, jpeg, gif or webp/u],
  ["data:image/svg+xml;base64,PHN2Zz4=", /data:image\/png, jpeg, gif or webp/u],
  ["ftp://example.com/a.png", /got "ftp:/u],
  ["picture", /got "picture"/u],
  [42, /image must be a string/u],
];

await test("Given setTaskImage, when the value is an http(s) URL or a raster data URI, then it is accepted", () => {
  for (const v of GOOD) assert.equal(set(v), null, v);
});

await test("Given setTaskImage, when the value is any other scheme, type or a non-string, then it is refused saying why", () => {
  for (const [v, why] of BAD) assert.match(String(set(v)), why, String(v));
});

await test("Given addTask carrying an image, when it is checked, then the same rule applies", () => {
  for (const v of GOOD) assert.equal(add(v), null, v);
  for (const [v, why] of BAD) {
    assert.match(String(add(v)), /^task\.image/u, String(v));
    assert.match(String(add(v)), why, String(v));
  }
  assert.match(
    String(
      validateCommand(plan(), {
        type: "addTask",
        task: { id: "n", label: "n", dur: 30, images: PNG },
      }),
    ),
    /task\.images is not a task field/u,
  );
});

await test("Given a task with an image, when null is sent, then the field goes and the sign-off stays", () => {
  const d = plan();
  applyCommand(d, { type: "setTaskImage", id: "t", image: PNG });
  assert.equal(d.tasks[0]!.image, PNG);
  applyCommand(d, { type: "setTaskImage", id: "t", image: null });
  assert.ok(!("image" in d.tasks[0]!));
  assert.equal(d.tasks[0]!.refinedAt, "2026-09-20T00:00:00.000Z");
});
