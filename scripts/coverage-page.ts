// coverage-page.ts — V8 coverage of the browser suite's one page, mapped back to web/src.
//
// The page is a Vite bundle, so V8 reports ranges over web/dist-cov/assets/*.js. The coverage run builds it
// unminified (`vite build --minify false`, sourcemaps kept) so those ranges line up with real source
// branches; v8-to-istanbul follows each chunk's source map to web/src/**.
//
// THE PAGE IS RELOADED (reloadPage in the harness) and a reload throws away the context's counters, so
// `take()` runs before each one and the takes are merged per script URL with @bcoe/v8-coverage. A chunk
// the page never loaded (a lazy import) has no V8 data at all; it is given an all-zero range so its
// sources count as uncovered rather than vanishing from the denominator.

import { mergeProcessCovs } from "@bcoe/v8-coverage";
import type { ProcessCov } from "@bcoe/v8-coverage";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "puppeteer-core";
import { convert, type Resolved } from "./coverage-v8.ts";

/**
 * Start collecting on the harness's page. `take()` before anything that discards the context;
 * `finish()` at the end writes `<root>/.verify/coverage/page.json` for coverage-floor.ts.
 */
export async function startPageCoverage(page: Page, dist: string, port: number) {
  const root = path.join(dist, "..", ".."); // dist is <root>/web/<dist dir>
  const out = path.join(root, ".verify/coverage/page.json");
  rmSync(out, { force: true }); // a stale file must never stand in for a run that wrote none
  const cdp = await page.createCDPSession();
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
  const takes: ProcessCov[] = [];
  let queue: Promise<void> = Promise.resolve();
  /** One at a time, in order: a navigation and the harness's own `take()` can ask together. */
  const take = async (flush = true) => {
    queue = queue.then(async () => {
      // LET THE PAGE'S PENDING FRAMES RUN FIRST. A requestAnimationFrame callback queued by the last
      // check (padForPanel, the arrow layer) either runs before the navigation throws it away or does
      // not, and which it was is the machine's speed, not the test's: the same suite measured 11 lines
      // apart. Two frames drain what is queued; the race only keeps a hidden tab, which never paints,
      // from hanging the run, and a context destroyed under us means the navigation won.
      if (flush)
        await page
          .evaluate(
            `Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), new Promise((r) => setTimeout(r, 1000))])`,
          )
          .catch(() => {
            // the navigation won; the counters are read all the same
          });
      const { result } = await cdp.send("Profiler.takePreciseCoverage");
      takes.push({ result });
    });
    return queue;
  };
  // EVERY NAVIGATION OF THE MAIN FRAME, not just the harness's reloadPage: a fork, an import or the page's
  // own `location.reload()` takes it to another document, and the old one's counters go with it. The
  // request is seen while the old document is still alive, so this takes at once (no frame flush: the
  // flush is for the harness's own, deliberate reloads) before the unload can beat it.
  page.on("request", (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame())
      take(false).catch(() => {
        // a page already gone has nothing left to read
      });
  });
  const web = path.join(dist, "..");
  const origin = `http://127.0.0.1:${port}`;
  /** The file on disk behind a script URL, the way the harness's stub serves it: dist/ first, web/ second. */
  const localOf = (url: string) => {
    if (!url.startsWith(origin + "/")) return null;
    const rel = decodeURIComponent(new URL(url).pathname);
    return [dist, web].map((d) => path.join(d, rel)).find((f) => existsSync(f)) ?? null;
  };
  const resolve = (url: string): Resolved => {
    const local = localOf(url);
    return local ? { path: local, sources: { source: readFileSync(local, "utf8") } } : null;
  };
  const finish = async () => {
    await take();
    await cdp.send("Profiler.stopPreciseCoverage");
    // Scripts with no URL, or a `pptr:` one, are the harness's own page.evaluate strings. Everything else is the page's.
    const merged = mergeProcessCovs(takes).result.filter(
      (s) => s.url && !s.url.startsWith("pptr:"),
    );
    const seen = new Set(merged.map((s) => localOf(s.url)));
    for (const f of readdirSync(path.join(dist, "assets")).filter((n) => n.endsWith(".js"))) {
      const file = path.join(dist, "assets", f);
      if (seen.has(file)) continue;
      // One zero range per line, not one over the file: v8-to-istanbul maps a range to the FIRST source
      // it lands in, so a single range would zero only the first module of a chunk.
      const ranges = [];
      let at = 0;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        ranges.push({ startOffset: at, endOffset: at + line.length, count: 0 });
        at += line.length + 1;
      }
      merged.push({
        scriptId: "0",
        url: `${origin}/assets/${f}`,
        functions: [{ functionName: "", isBlockCoverage: false, ranges }],
      });
    }
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(await convert(merged, resolve, root)));
  };
  return { take, finish };
}
