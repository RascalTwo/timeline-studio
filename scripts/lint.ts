// lint.ts — the lint gate: Oxlint with its type-aware engine (tsgolint), once per TypeScript program.
//
//   bun lint.ts            human report, exit 1 on any finding
//   bun lint.ts --json     [{program, files, typeAware, findings}] per program
//   bun lint.ts --dir <d>  the same for one folder that has a tsconfig.json: scripts/lint-canary/
//                          (a planted floating promise) and a scratch folder the meta-test writes,
//                          to prove that types reach the rules and that disables need a reason.
//                          Every rule is on there: OFF_RULES does not apply to --dir.
//   bun lint.ts --fix      apply Oxlint's safe autofixes first (review the diff), then report as usual
//   bun lint.ts --rules    {off, testOff}: the exception maps, for the meta-test
//
// Ported from viz's lib/lint/lint.ts, with the fallback taken out. Three silent failures are why:
//   - type-aware rules need a tsconfig.json IN the cwd of the run. Measured on viz, a --tsconfig
//     pointing elsewhere is ignored and the same rule reports 0 hits instead of 133, because every
//     type becomes `any`. So each program runs with its own folder as cwd, and a folder without a
//     tsconfig is an error rather than a clean result.
//   - dropping `--type-aware` makes the type-aware findings vanish with exit 0.
//   - a run that falls back to non-type-aware when tsgolint fails. There is none: an engine
//     failure is a run failure.
// Any finding fails the run, and so does a disable comment that gives no reason or whose
// finding is gone (--report-unused-disable-directives).

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OFF_RULES, TEST_OFF_RULES, oxlintConfig } from "./lint-config.ts";

const SCRIPTS = import.meta.dir;
const ROOT = path.resolve(SCRIPTS, "..");
const OXLINT = path.join(SCRIPTS, "node_modules/oxlint/bin/oxlint");
const TSGOLINT =
  process.env["OXLINT_TSGOLINT_PATH"] ??
  path.join(
    SCRIPTS,
    "node_modules/@oxlint-tsgolint",
    `${process.platform}-${process.arch}`,
    "tsgolint",
  );

/** Every program with a tsconfig. `shared/*.js` and `web/dist` are build output, so only TypeScript is linted. */
const PROGRAMS = ["sync-server", "web", "shared", "scripts"];
const IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/lint-canary/**",
  "**/*.d.ts",
  "**/*.js",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.jsx",
];

export type ProgramResult = {
  program: string;
  files: number;
  typeAware: boolean;
  findings: string[];
};

/** The `.ts`/`.tsx` files Oxlint is given: not a declaration file, not under node_modules, dist or the canary. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === "lint-canary") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.tsx?$/u.test(e.name) && !e.name.endsWith(".d.ts")) out.push(abs);
    }
  };
  walk(dir);
  return out.toSorted();
}

/** A disable comment must say why: `// oxlint-disable-next-line rule -- reason`. */
function bareDisables(dir: string, files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    for (const [i, line] of readFileSync(f, "utf8").split("\n").entries()) {
      const m = line.match(/(?:\/\/|\/\*)\s*(?:oxlint|eslint)-disable[\w-]*(.*)$/u);
      if (m && !/\s--\s+\S.{2,}/u.test(m[1]!))
        out.push(
          `${path.relative(dir, f)}:${i + 1} lint-disable without a reason: add " -- <why>"`,
        );
    }
  }
  return out;
}

type Diagnostic = {
  message: string;
  code?: string;
  filename: string;
  labels?: { span: { line: number; column: number } }[];
};

function lintProgram(name: string, dir: string, exceptions = true, fix = false): ProgramResult {
  if (!existsSync(path.join(dir, "tsconfig.json")))
    throw new Error(
      `${name}: no tsconfig.json in ${dir}; type-aware rules would see every type as \`any\``,
    );
  if (!existsSync(OXLINT)) throw new Error(`oxlint is not installed: run \`npm ci\` in ${SCRIPTS}`);
  if (!existsSync(TSGOLINT))
    throw new Error(`tsgolint is not installed at ${TSGOLINT}: run \`npm ci\` in ${SCRIPTS}`);
  const files = tsFiles(dir);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ts-lint-"));
  try {
    const config = path.join(tmp, "oxlintrc.json");
    writeFileSync(config, JSON.stringify(oxlintConfig(name, exceptions)));
    // To a FILE, not a pipe: oxlint exits before a pipe drains, and a big result arrives cut in half.
    const outFile = path.join(tmp, "out.json");
    const args = [
      "--type-aware",
      "--report-unused-disable-directives",
      ...(fix ? ["--fix"] : []),
      "-c",
      config,
      "-f",
      "json",
      ...IGNORE.flatMap((g) => ["--ignore-pattern", g]),
      ".",
    ];
    const r = Bun.spawnSync({
      cmd: [process.execPath, OXLINT, ...args],
      cwd: dir,
      env: { ...process.env, OXLINT_TSGOLINT_PATH: TSGOLINT },
      stdout: Bun.file(outFile),
    });
    const out = readFileSync(outFile, "utf8");
    const start = out.indexOf("{");
    // Exit 1 with a report is "findings"; exit 1 without one is the engine failing (bad config, bad tsgolint).
    if (start < 0 || r.exitCode > 1)
      throw new Error(
        `${name}: oxlint did not run (exit ${r.exitCode}): ${(r.stderr.toString() + out).trim().slice(0, 400)}`,
      );
    const parsed = JSON.parse(out.slice(start)) as { diagnostics: Diagnostic[] };
    const found = parsed.diagnostics.map((d) => {
      const at = d.labels?.[0]?.span;
      return `${d.filename}:${at?.line ?? 0}:${at?.column ?? 0} ${d.code ?? "unused-disable"} — ${d.message}`;
    });
    return {
      program: name,
      files: files.length,
      typeAware: args.includes("--type-aware"),
      findings: [...found, ...bareDisables(dir, files)],
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  if (argv.includes("--rules")) {
    console.log(JSON.stringify({ off: OFF_RULES, testOff: TEST_OFF_RULES }));
    return 0;
  }
  const only = argv.indexOf("--dir");
  const results =
    only < 0
      ? PROGRAMS.map((p) => lintProgram(p, path.join(ROOT, p), true, argv.includes("--fix")))
      : [lintProgram(path.basename(argv[only + 1]!), path.resolve(argv[only + 1]!), false)];
  if (argv.includes("--json")) console.log(JSON.stringify(results));
  else
    for (const r of results) {
      console.log(
        `${r.findings.length > 0 ? "✗" : "✓"} ${r.program}: ${r.files} files, type-aware: ${r.typeAware ? "yes" : "NO"}, ${r.findings.length} findings`,
      );
      for (const f of r.findings.slice(0, 200)) console.log(`    ${r.program}/${f}`);
      if (r.findings.length > 200) console.log(`    … ${r.findings.length - 200} more`);
    }
  return results.some((r) => r.findings.length > 0 || !r.typeAware) ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`✗ lint engine failure: ${(e as Error).message}`);
  process.exitCode = 1;
}
