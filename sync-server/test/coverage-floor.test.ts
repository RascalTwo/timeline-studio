// THE COVERAGE FLOOR'S OWN TEST. A gate that cannot fail is not a gate: this runs the real
// `scripts/coverage-floor.ts` over a scratch repo whose measured numbers are known (server: 8/10
// lines = 80.0%, 3/4 branches = 75.0%; page: 5/5 lines, 2/2 branches), and pins that the floor
// fails below, passes at, raises above (locally, never in CI), and refuses an exclusion that
// carries no reason.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPTS = new URL("../../scripts/", import.meta.url).pathname;
const code = (n: number) => Array.from({ length: n }, (_, i) => `const x${i} = ${i};`);

type Opts = {
  floor?: { server?: [number, number]; page?: [number, number] };
  exclude?: { glob: string; why: string }[];
  serverSrc?: string[];
  /** a second included source file, for the suite to have not loaded */
  unloaded?: boolean;
  server?: object | null;
  page?: object | null;
};

/** A scratch repo, the run of coverage-floor.ts over it, and the floor file as it was left. */
function scratch(o: Opts = {}, env: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ts-cov-"));
  const put = (f: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), text);
  };
  put("sync-server/src/a.ts", (o.serverSrc ?? code(10)).join("\n") + "\n");
  if (o.unloaded) put("sync-server/src/never.ts", "export const n = 1;\n");
  put("web/src/p.ts", code(5).join("\n") + "\n");
  const serverLines = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [i + 1, i < 8 ? 1 : 0]),
  );
  if (o.server !== null)
    put(
      ".verify/coverage/server.json",
      JSON.stringify(
        o.server ?? {
          files: {
            "sync-server/src/a.ts": {
              lines: serverLines,
              branches: [
                [1, 1],
                [2, 1],
                [3, 1],
                [4, 0],
              ],
            },
          },
          unmapped: [],
        },
      ),
    );
  const pageLines = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [i + 1, 1]));
  if (o.page !== null)
    put(
      ".verify/coverage/page.json",
      JSON.stringify(
        o.page ?? {
          files: {
            "web/src/p.ts": {
              lines: pageLines,
              branches: [
                [1, 1],
                [2, 1],
              ],
            },
          },
          unmapped: [],
        },
      ),
    );
  const [sl, sb] = o.floor?.server ?? [80, 75];
  const [pl, pb] = o.floor?.page ?? [100, 100];
  put(
    "scripts/coverage-floor.json",
    JSON.stringify({
      floor: {
        server: { lines: sl, branches: sb },
        page: { lines: pl, branches: pb },
      },
      include: { server: ["sync-server/src/**/*.ts"], page: ["web/src/**/*.ts"] },
      exclude: o.exclude ?? [],
    }),
  );
  const r = spawnSync("bun", ["coverage-floor.ts", "--root", root], {
    cwd: SCRIPTS,
    encoding: "utf8",
    env: { ...process.env, CI: "", ...env },
  });
  const floor = JSON.parse(
    readFileSync(path.join(root, "scripts/coverage-floor.json"), "utf8"),
  ) as {
    floor: Record<string, { lines: number; branches: number }>;
  };
  rmSync(root, { recursive: true });
  return { status: r.status, out: r.stdout + r.stderr, floor: floor.floor };
}

await test("Given a floor equal to the measured numbers, when it runs, then it passes, prints both suites and writes nothing", () => {
  const r = scratch();
  assert.equal(r.status, 0, r.out);
  assert.match(
    r.out,
    /coverage: server lines 80\.0% branches 75\.0% \(floor 80\.0% \/ 75\.0%\); excluded 0 files, 0 lines/u,
  );
  assert.match(r.out, /coverage: page lines 100\.0% branches 100\.0%/u);
  assert.doesNotMatch(r.out, /floor raised/u);
  assert.deepEqual(r.floor["server"], { lines: 80, branches: 75 });
});

await test("Given line coverage below its floor, when it runs, then it fails naming suite, metric, both numbers and the report", () => {
  const r = scratch({ floor: { server: [80.1, 75] } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ coverage: server lines 80\.0% is below its floor 80\.1%/u);
  assert.match(r.out, /\.verify\/coverage\/server-uncovered\.txt/u);
});

await test("Given branch coverage below its floor, when it runs, then the page and the branches metric are named", () => {
  const r = scratch({ floor: { page: [100, 100.1] } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✗ coverage: page branches 100\.0% is below its floor 100\.1%/u);
});

await test("Given a measured number above the floor, when it runs locally, then only that number is raised, and it says to stage the file", () => {
  const r = scratch({ floor: { server: [70, 75], page: [100, 100] } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /floor raised to server lines 80%; stage scripts\/coverage-floor\.json/u);
  assert.deepEqual(r.floor["server"], { lines: 80, branches: 75 });
});

await test("Given a measured number above the floor, when CI is set, then the floor file is untouched and the run passes", () => {
  const r = scratch({ floor: { server: [70, 60] } }, { CI: "true" });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /floor raised/u);
  assert.deepEqual(r.floor["server"], { lines: 70, branches: 60 });
});

await test("Given an ignore comment with no reason, when it runs, then it fails; with a reason it passes and counts the exclusion", () => {
  const bare = code(10);
  bare[8] += " /* node:coverage ignore next */";
  const no = scratch({ serverSrc: bare });
  assert.equal(no.status, 1, no.out);
  assert.match(
    no.out,
    /sync-server\/src\/a\.ts:9 excludes code from coverage but gives no reason/u,
  );

  // Line 9 of 10 is a missed line: ignoring it takes it out of both sides, 8/9 = 88.8%.
  const ok = code(10);
  ok[8] += " /* v8 ignore next -- only reachable on a real S3 */";
  const yes = scratch({ serverSrc: ok, floor: { server: [88.8, 75] } });
  assert.equal(yes.status, 0, yes.out);
  assert.match(yes.out, /coverage: server lines 88\.8%.*excluded 0 files, 1 lines/u);
});

await test("Given an exclude entry with an empty reason, when it runs, then it fails", () => {
  const r = scratch({ exclude: [{ glob: "web/nothing/**", why: "  " }] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /exclude "web\/nothing\/\*\*" has no reason/u);
});

await test("Given an exclude entry with a reason, when it matches a measured file, then the file leaves the numbers and the summary counts it", () => {
  const r = scratch({ exclude: [{ glob: "sync-server/src/a.ts", why: "scratch" }] });
  // Nothing of the server suite is left to measure, which is itself a failure, but the file is counted.
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /excluded 1 files/u);
});

await test("Given a suite that left no data, or a script it could not map, or a file nobody classified, when it runs, then it fails rather than passing on an empty set", () => {
  const none = scratch({ server: null });
  assert.equal(none.status, 1, none.out);
  assert.match(none.out, /✗ coverage: server left no coverage data/u);

  const unmapped = scratch({ page: { files: {}, unmapped: ["http://x/assets/a.js"] } });
  assert.equal(unmapped.status, 1, unmapped.out);
  assert.match(
    unmapped.out,
    /http:\/\/x\/assets\/a\.js ran in the page run but maps to no source file/u,
  );

  const stray = scratch({
    server: {
      files: {
        "sync-server/src/a.ts": { lines: { 1: 1 }, branches: [] },
        "elsewhere/b.ts": { lines: { 1: 1 }, branches: [] },
      },
      unmapped: [],
    },
    floor: { server: [0, 0] },
  });
  assert.equal(stray.status, 1, stray.out);
  assert.match(
    stray.out,
    /elsewhere\/b\.ts is in the server data but neither included nor excluded/u,
  );
});

await test("Given a measured source file no test loaded, when it runs, then it fails instead of shrinking the denominator", () => {
  const r = scratch({ unloaded: true, floor: { server: [0, 0] } });
  assert.equal(r.status, 1, r.out);
  assert.match(
    r.out,
    /sync-server\/src\/never\.ts is measured by the server suite but no test loaded it/u,
  );
});
