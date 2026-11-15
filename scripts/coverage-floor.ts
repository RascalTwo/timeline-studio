// coverage-floor.ts — the coverage ratchet: lines and branches, server and page, each against a
// committed floor that only goes up. Ported from viz's lib/verify/tier.ts (`ratchet`, `readIgnores`).
//
//   bun coverage-floor.ts [--root <dir>]     summary line per suite, exit 1 below a floor
//
// It reads what the two suites left under <root>/.verify/coverage/ and nothing else:
//   server.json   scripts/coverage-server.ts, the last step of sync-server's `npm test` (NODE_V8_COVERAGE)
//   page.json     scripts/coverage-page.ts, written by `playback-harness.ts --check --coverage`
// and the floor file scripts/coverage-floor.json: the four numbers, which files each suite measures
// (`include`), and every file left out (`exclude`, each entry with a `why`).
//
// A COVERAGE FAILURE IS NEVER KNOWN-RED. check-gate.sh fails on the `✗ coverage` lines below before it
// reads known-red.txt, and requires the `coverage: page` summary to exist at all.
//
// NOTHING IS MEASURED FROM NOTHING. A suite that left no data, a measured file the suite never loaded,
// a file in the data that is neither included nor excluded, and a script the page ran that could not be
// mapped to a source file are all failures, never a smaller denominator.
//
// THE FLOOR RISES LOCALLY AND NEVER ELSEWHERE. A local run above it rewrites the file and says to stage
// it. With CI set it is never written: a floor below the measured number passes, the reverse fails.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Suite = "server" | "page";
export type FileCov = { lines: Record<string, number>; branches: [line: number, hits: number][] };
/** What a suite measured, repo-relative paths. `unmapped` names scripts that ran with no source behind them. */
export type Measured = { files: Record<string, FileCov>; unmapped: string[] };
type Pair = { lines: number; branches: number };
export type FloorFile = {
  floor: Record<Suite, Pair>;
  include: Record<Suite, string[]>;
  exclude: { glob: string; why: string }[];
};

const SUITES: Suite[] = ["server", "page"];
export const FLOOR_FILE = "scripts/coverage-floor.json";
const OUT = ".verify/coverage";

/** Percent, rounded DOWN to 0.1 and kept as tenths, so a floor is never above the truth and compares exactly. */
const tenths = (covered: number, total: number) => Math.floor((1000 * covered) / total);
const show = (t: number) => `${(t / 10).toFixed(1)}%`;

type Ignore = { line: number; reason: string; lines: Set<number> };
const IGNORE_RE =
  /\/\*\s*(?:[cv]8|node:coverage)\s+(ignore\s+next(?:\s+(\d+))?|ignore\s+start|ignore\s+stop|disable|enable)\b(.*?)\*\//u;

/** The exclusion comments in one file: which lines each covers, and its reason ("" = none given). */
export function readIgnores(src: string[]): Ignore[] {
  const out: Ignore[] = [];
  let open: Ignore | null = null;
  for (const [i, text] of src.entries()) {
    const line = i + 1;
    if (open) open.lines.add(line);
    const m = IGNORE_RE.exec(text);
    if (!m) continue;
    const kind = m[1] ?? "";
    if (kind === "ignore stop" || kind === "enable") {
      open = null;
      continue;
    }
    const ig: Ignore = {
      line,
      reason: /^\s*--\s*(.*\S)/u.exec(m[3] ?? "")?.[1] ?? "",
      lines: new Set([line]),
    };
    if (kind === "ignore start" || kind === "disable") open = ig;
    else if (/^\W*\/\*/u.test(text)) {
      // on its own line → the next N lines; after code → this line only
      for (let k = 1; k <= Number(m[2] ?? 1); k++) ig.lines.add(line + k);
    }
    out.push(ig);
  }
  return out;
}

const match = (glob: string, file: string) => new Bun.Glob(glob).match(file);
const ranges = (ns: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i] ?? 0;
    let b = a;
    while (ns[i + 1] === b + 1) b = ns[++i] ?? b;
    out.push(a === b ? `${a}` : `${a}-${b}`);
  }
  return out.join(" ");
};

type Result = {
  lines: number;
  branches: number;
  excludedFiles: number;
  excludedLines: number;
  errors: string[];
  report: string;
};

/** One suite's numbers from what it measured. `errors` holds everything that makes the number untrustworthy. */
export function measure(
  suite: Suite,
  data: Measured,
  cfg: FloorFile,
  root: string,
  listSources: (glob: string) => string[],
): Result {
  const errors = data.unmapped.map(
    (s) => `${s} ran in the ${suite} run but maps to no source file (unmeasured)`,
  );
  const rule = (f: string) => cfg.exclude.find((e) => match(e.glob, f));
  const included = (f: string) => cfg.include[suite].some((g) => match(g, f));
  let excludedFiles = 0;
  let excludedLines = 0;
  let covered = 0;
  let total = 0;
  let bCovered = 0;
  let bTotal = 0;
  const report: string[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  for (const [f, cov] of Object.entries(data.files).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    if (rule(f)) {
      excludedFiles++;
      continue;
    }
    if (!included(f)) {
      errors.push(
        `${f} is in the ${suite} data but neither included nor excluded in ${FLOOR_FILE}`,
      );
      continue;
    }
    seen.add(f);
    const src = readFileSync(path.join(root, f), "utf8").split("\n");
    const ignores = readIgnores(src);
    for (const i of ignores) {
      if (i.reason) ignored.push(`${f}:${i.line} ${i.reason}`);
      else
        errors.push(
          `${f}:${i.line} excludes code from coverage but gives no reason: /* v8 ignore next -- <why> */`,
        );
    }
    const skip = new Set(ignores.flatMap((i) => [...i.lines]));
    // Only lines with code count: Node and v8-to-istanbul both mark comment and blank lines inside a
    // function that ran as lines, which would inflate the percentage.
    const notCode = (l: number) => /^\s*($|\/\/|\/\*|\*)/u.test(src[l - 1] ?? "");
    const lines = Object.entries(cov.lines)
      .map(([l, n]) => [Number(l), n] as const)
      .filter(([l]) => !notCode(l));
    excludedLines += lines.filter(([l]) => skip.has(l)).length;
    const mine = lines.filter(([l]) => !skip.has(l));
    const branches = cov.branches.filter(([l]) => !skip.has(l));
    covered += mine.filter(([, n]) => n > 0).length;
    total += mine.length;
    bCovered += branches.filter(([, n]) => n > 0).length;
    bTotal += branches.length;
    const missed = mine
      .filter(([, n]) => !n)
      .map(([l]) => l)
      .toSorted((a, b) => a - b);
    const missedB = [...new Set(branches.filter(([, n]) => !n).map(([l]) => l))].toSorted(
      (a, b) => a - b,
    );
    if (missed.length > 0 || missedB.length > 0)
      report.push(
        `${f}\n  lines not run:    ${ranges(missed) || "-"}\n  branches not run: ${ranges(missedB) || "-"}`,
      );
  }
  for (const g of cfg.include[suite])
    for (const f of listSources(g))
      if (!seen.has(f) && !rule(f))
        errors.push(
          `${f} is measured by the ${suite} suite but no test loaded it (or it emits no code: exclude it with a reason)`,
        );
  if (total === 0) errors.push(`the ${suite} run measured no lines at all`);
  return {
    lines: total ? tenths(covered, total) : 0,
    branches: bTotal ? tenths(bCovered, bTotal) : 1000,
    excludedFiles,
    excludedLines,
    errors,
    report: [
      `${suite}: lines ${covered}/${total}, branches ${bCovered}/${bTotal}`,
      ...report,
      "",
      `exclusions in source (${ignored.length}):`,
      ...ignored.map((i) => `  ${i}`),
      "",
    ].join("\n"),
  };
}

const num = (v: unknown) => Math.round(Number(v) * 10);

/** The floor file, validated: the four numbers, and a reason on every exclusion. */
export function readFloor(file: string): { cfg: FloorFile; errors: string[] } {
  const cfg = JSON.parse(readFileSync(file, "utf8")) as FloorFile;
  const errors = cfg.exclude
    .filter((e) => !e.glob || !e.why?.trim())
    .map((e) => `${FLOOR_FILE}: exclude "${e.glob}" has no reason (why)`);
  for (const s of SUITES)
    for (const k of ["lines", "branches"] as const)
      if (!Number.isFinite(num(cfg.floor[s]?.[k])))
        errors.push(`${FLOOR_FILE}: no floor for ${s} ${k}`);
  return { cfg, errors };
}

/** Every file under `root` matching one include glob; node_modules and dist never. */
const listFiles = (root: string) => (glob: string) => {
  const g = new Bun.Glob(glob);
  const walk = (dir: string): string[] =>
    readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
      const rel = path.join(dir, d.name);
      if (
        d.name === "node_modules" ||
        d.name === "dist" ||
        d.name === "dist-cov" ||
        d.name.startsWith(".")
      )
        return [];
      return d.isDirectory() ? walk(rel) : [rel].filter((f) => g.match(f));
    });
  return walk(glob.split("/")[0]?.includes("*") ? "." : (glob.split("/")[0] ?? "."));
};

/** Run both suites against the floor. Returns the lines to print and the exit code. */
export function run(root: string, env: Record<string, string | undefined>) {
  const out: string[] = [];
  const floorPath = path.join(root, FLOOR_FILE);
  const { cfg, errors: cfgErrors } = readFloor(floorPath);
  let failed = cfgErrors.length > 0;
  for (const e of cfgErrors) out.push(`✗ coverage: ${e}`);
  const file = (s: Suite) => path.join(root, OUT, `${s}.json`);
  const read = (s: Suite) =>
    existsSync(file(s)) ? (JSON.parse(readFileSync(file(s), "utf8")) as Measured) : null;
  const data: Record<Suite, Measured | null> = { server: read("server"), page: read("page") };
  const next = structuredClone(cfg.floor);
  let raised = false;
  for (const s of SUITES) {
    const d = data[s];
    if (!d) {
      out.push(`✗ coverage: ${s} left no coverage data (${file(s)})`);
      failed = true;
      continue;
    }
    const r = measure(s, d, cfg, root, listFiles(root));
    mkdirSync(path.join(root, OUT), { recursive: true });
    const reportPath = path.join(OUT, `${s}-uncovered.txt`);
    writeFileSync(path.join(root, reportPath), r.report);
    const fl = { lines: num(cfg.floor[s].lines), branches: num(cfg.floor[s].branches) };
    out.push(
      `coverage: ${s} lines ${show(r.lines)} branches ${show(r.branches)} (floor ${show(fl.lines)} / ${show(fl.branches)}); excluded ${r.excludedFiles} files, ${r.excludedLines} lines`,
    );
    for (const e of r.errors) out.push(`✗ coverage: ${e}`);
    if (r.errors.length > 0) failed = true;
    for (const k of ["lines", "branches"] as const) {
      if (r[k] < fl[k]) {
        failed = true;
        out.push(
          `✗ coverage: ${s} ${k} ${show(r[k])} is below its floor ${show(fl[k])}; uncovered ${k} are listed in ${reportPath}`,
        );
      } else if (r[k] > fl[k] && r.errors.length === 0) {
        next[s][k] = r[k] / 10;
        raised = true;
      }
    }
  }
  if (raised && !failed && !env["CI"]) {
    writeFileSync(floorPath, JSON.stringify({ ...cfg, floor: next }, null, 2) + "\n");
    const was = (s: Suite, k: keyof Pair) => cfg.floor[s][k] !== next[s][k];
    const what = SUITES.flatMap((s) =>
      (["lines", "branches"] as const)
        .filter((k) => was(s, k))
        .map((k) => `${s} ${k} ${next[s][k]}%`),
    );
    out.push(`floor raised to ${what.join(", ")}; stage ${FLOOR_FILE}`);
  }
  return { out, code: failed ? 1 : 0 };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root");
  const root =
    i > 0 ? path.resolve(process.argv[i + 1] ?? ".") : path.resolve(import.meta.dir, "..");
  const { out, code } = run(root, process.env);
  console.log(out.join("\n"));
  process.exitCode = code;
}
