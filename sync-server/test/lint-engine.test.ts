// THE LINT GATE'S OWN TEST. `scripts/lint.ts` can pass for the wrong reason: drop `--type-aware`
// and the type-aware findings vanish with exit 0; lint a folder without its tsconfig and every
// type becomes `any`, so the unsafe-* rules find nothing; empty a tsconfig `include` and a
// program lints zero files. A green gate proves none of that, so this test pins the engine itself.
// It runs the real runner, so it also fails when lint.ts stops doing what these assertions read.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

type Result = { program: string; files: number; typeAware: boolean; findings: string[] };
const SCRIPTS = new URL("../../scripts/", import.meta.url).pathname;

/** Run the runner. Exit 1 is "findings"; the report on stdout is what is read, and no report is a failed engine. */
function lint(...args: string[]): Result[] {
  const r = spawnSync("bun", ["lint.ts", "--json", ...args], {
    cwd: SCRIPTS,
    encoding: "utf8",
    maxBuffer: 2 ** 28,
  });
  assert.ok(r.stdout.startsWith("["), `lint.ts printed no report (exit ${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as Result[];
}

const real = lint();

await test("Given the real run, when it reports, then it covers the four programs and every one was type-aware", () => {
  assert.deepEqual(real.map((p) => p.program).toSorted(), [
    "scripts",
    "shared",
    "sync-server",
    "web",
  ]);
  for (const p of real) assert.equal(p.typeAware, true, `${p.program} was not linted type-aware`);
});

// Floors from the 2026-10-09 baseline (web 30, sync-server 52, shared 3, scripts 4): an emptied
// `include` or glob lints nothing and reports nothing. Raise a floor when a program grows.
for (const [program, floor] of Object.entries({
  web: 25,
  "sync-server": 45,
  shared: 3,
  scripts: 4,
})) {
  await test(`Given ${program}, when it is linted, then at least ${floor} files were read`, () => {
    const got = real.find((p) => p.program === program)?.files ?? 0;
    assert.ok(got >= floor, `${program}: ${got} files, expected at least ${floor}`);
  });
}

await test("Given a floating promise in a folder with a tsconfig, when it is linted, then no-floating-promises names it (types flow)", () => {
  const canary = lint("--dir", "lint-canary")[0];
  assert.ok(
    canary!.findings.some((f) => f.includes("typescript(no-floating-promises)")),
    `the canary's floating promise was not found:\n${canary!.findings.join("\n")}`,
  );
});

/** A scratch program: the canary's tsconfig plus one file. */
function scratch(source: string): Result {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lint-scratch-"));
  try {
    copyFileSync(path.join(SCRIPTS, "lint-canary/tsconfig.json"), path.join(dir, "tsconfig.json"));
    writeFileSync(path.join(dir, "scratch.ts"), source);
    return lint("--dir", dir)[0]!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const FLOATING = "async function work(): Promise<void> {}\n";
// Spelled in two halves so lint.ts's own bare-disable scan does not read these fixtures as real disables.
const DISABLE = ["// oxlint", "disable-next-line typescript/no-floating-promises"].join("-");

await test("Given a disable with no reason, when it is linted, then it is a finding", () => {
  const r = scratch(`${FLOATING}${DISABLE}\nwork();\n`);
  assert.ok(
    r.findings.some((f) => f.includes("without a reason")),
    r.findings.join("\n"),
  );
});

await test("Given a disable with a reason over a real finding, when it is linted, then it passes the reason and stale checks", () => {
  const r = scratch(`${FLOATING}${DISABLE} -- fire and forget\nwork();\n`);
  assert.ok(
    !r.findings.some((f) => f.includes("without a reason") || f.includes("unused")),
    r.findings.join("\n"),
  );
  assert.ok(!r.findings.some((f) => f.includes("no-floating-promises")), r.findings.join("\n"));
});

await test("Given a disable above a line with no finding, when it is linted, then it is stale and a finding", () => {
  const r = scratch(
    `${FLOATING}${DISABLE} -- no longer needed\nconst x = 1;\nexport { x, work };\n`,
  );
  assert.ok(
    r.findings.some((f) => f.includes("Unused eslint-disable") || f.includes("unused")),
    r.findings.join("\n"),
  );
});

const rules = JSON.parse(
  spawnSync("bun", ["lint.ts", "--rules"], { cwd: SCRIPTS, encoding: "utf8" }).stdout,
) as { off: Record<string, string>; testOff: Record<string, string> };

await test("Given OFF_RULES and TEST_OFF_RULES, when read, then every rule has a reason", () => {
  for (const [rule, why] of Object.entries({ ...rules.off, ...rules.testOff }))
    assert.ok(why.trim().length > 0, `${rule} is off with no reason`);
});

// A `TRIAGE: <n> hits` entry was the burn-down's placeholder for a rule the human had not yet decided
// on. None may come back: an entry is either gone (the rule is on) or carries an agreed reason.
await test("Given OFF_RULES, when read, then no rule is still waiting for a decision (TRIAGE)", () => {
  const waiting = Object.entries({ ...rules.off, ...rules.testOff })
    .filter(([, why]) => why.startsWith("TRIAGE"))
    .map(([rule]) => rule);
  assert.deepEqual(waiting, []);
});
