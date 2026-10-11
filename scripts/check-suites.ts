// The three slow jobs of `npm run check`, run together: the sync-server suite, the browser suite on the
// unminified bundle (what coverage is measured on) and the browser suite on the minified one (what ships).
// They share nothing but the compiled shared/*.js, which is built once here first; each browser run gets
// its own port and its own build directory (playback-harness.ts: HARNESS_PORT, and --coverage reads web/dist-cov).
//
// CHECK_BROWSERS is how many browsers run at once (default 2, the most there are runs for; 1 runs them
// one after the other, which is the old behaviour and the setting to reach for if a loaded machine makes
// checks flake). The server suite is not a browser and always runs alongside.
//
// Each job's output is held and printed whole once it ends, in a fixed order, so the log reads like the
// serial run did and scripts/check-gate.sh still finds its `N/N checks passed` and `FAIL` lines.
import nodePath from "node:path";

const HERE = import.meta.dir;
const WEB = nodePath.join(HERE, "..", "web");
const BROWSERS = Math.max(1, Math.floor(Number(process.env["CHECK_BROWSERS"] ?? 2)) || 1);

type Job = {
  name: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  browser: boolean;
};
const prepared = { HARNESS_PREPARED: "1" };
const jobs: Job[] = [
  {
    name: "sync-server suite",
    cmd: ["npm", "--prefix", nodePath.join(HERE, "..", "sync-server"), "test"],
    cwd: HERE,
    env: {},
    browser: false,
  },
  {
    name: "browser suite, unminified (coverage)",
    cmd: ["bun", "playback-harness.ts", "--check", "--coverage"],
    cwd: HERE,
    env: { ...prepared, HARNESS_PORT: "5212" },
    browser: true,
  },
  {
    name: "browser suite, minified (ships)",
    cmd: ["bun", "playback-harness.ts", "--check"],
    cwd: HERE,
    env: { ...prepared, HARNESS_PORT: "5211" },
    browser: true,
  },
];

const prep = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) {
    console.error(`✗ ${cmd.join(" ")} failed`);
    // oxlint-disable-next-line unicorn/no-process-exit -- nothing after a failed build can mean anything
    process.exit(1);
  }
};
// Once, before anything starts: the browser runs each used to do this themselves, and two of them writing
// shared/*.js at once would hand one of them a half-written file. The two bundles are built here too,
// because the sync-server suite reads web/dist (bundle.test.ts) and a build running beside it would be
// emptying that directory under it.
prep(
  [
    nodePath.join(HERE, "node_modules", ".bin", "tsc"),
    "-p",
    nodePath.join(HERE, "..", "shared", "tsconfig.json"),
  ],
  HERE,
);
const vite = nodePath.join(WEB, "node_modules", ".bin", "vite");
const builds = [
  { what: "web typecheck", cmd: [nodePath.join(WEB, "node_modules", ".bin", "tsc"), "--noEmit"] },
  { what: "web bundle (minified, web/dist)", cmd: [vite, "build", "--outDir", "dist"] },
  {
    what: "web bundle (unminified, web/dist-cov)",
    cmd: [vite, "build", "--outDir", "dist-cov", "--minify", "false"],
  },
];
const built = await Promise.all(
  builds.map(async (b) => {
    const p = Bun.spawn(b.cmd, { cwd: WEB, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { ...b, out, err, code };
  }),
);
for (const b of built) {
  console.log(`▸ ${b.what}`);
  process.stdout.write(b.out);
  process.stderr.write(b.err);
}
if (built.some((b) => b.code !== 0)) {
  console.error("✗ build failed");
  // oxlint-disable-next-line unicorn/no-process-exit -- nothing after a failed build can mean anything
  process.exit(1);
}

let freeBrowsers = BROWSERS;
const waiting: (() => void)[] = [];
const takeBrowser = async () => {
  if (freeBrowsers > 0) {
    freeBrowsers--;
    return;
  }
  await new Promise<void>((go) => {
    waiting.push(go);
  });
};
const giveBrowser = () => {
  const next = waiting.shift();
  if (next) next();
  else freeBrowsers++;
};

const wall = Date.now();
const results = await Promise.all(
  jobs.map(async (j) => {
    if (j.browser) await takeBrowser();
    const started = Date.now();
    const p = Bun.spawn(j.cmd, {
      cwd: j.cwd,
      env: { ...process.env, ...j.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (j.browser) giveBrowser();
    return { j, out, err, code, seconds: Math.round((Date.now() - started) / 1000) };
  }),
);

for (const r of results) {
  console.log(`▸ ${r.j.name} (${r.seconds}s, exit ${r.code})`);
  process.stdout.write(r.out);
  process.stderr.write(r.err);
}
console.log(
  `▸ ran ${results.map((r) => `${r.j.name} ${r.seconds}s`).join(", ")}; wall ${Math.round((Date.now() - wall) / 1000)}s with ${BROWSERS} browser(s) at once`,
);
// oxlint-disable-next-line unicorn/no-process-exit -- the exit status is the answer
process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
