// coverage-server.ts — the sync-server suite's coverage, from the raw V8 files `NODE_V8_COVERAGE` leaves.
//
//   bun coverage-server.ts [--root <dir>]     .verify/coverage/server-v8/*.json → server.json
//
// WHY NOT NODE'S OWN LCOV REPORTER. `tsx --test --experimental-test-coverage` merges the many test
// processes' ranges itself, and its merge is not stable: V8 omits a block whose count equals its
// parent's, so processes disagree about where a function's blocks begin, and the same suite measured
// 95.2-95.5% of lines and a branch denominator that moved by a dozen from one run to the next with no
// test changing (covered branches stayed put). Merging the raw ranges with @bcoe/v8-coverage first and
// converting once, the way the page side does, removes that.
//
// tsx hands V8 transpiled code, and Node writes the source map for it into each file's
// `source-map-cache` — with the generated line lengths but not the generated text. v8-to-istanbul only
// uses that text for line boundaries (and for ignore comments, which this repo reads from the original
// source), so a placeholder with the right line lengths is exact.

import { mergeProcessCovs } from "@bcoe/v8-coverage";
import type { ProcessCov, ScriptCov } from "@bcoe/v8-coverage";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, type Resolved } from "./coverage-v8.ts";

type Cache = Record<string, { lineLengths: number[]; data: object }>;
type V8File = { result: ScriptCov[]; "source-map-cache"?: Cache };

export async function serverCoverage(root: string) {
  const dir = path.join(root, ".verify/coverage/server-v8");
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^coverage-.*\.json$/u.test(f))
    : [];
  const ours = (url: string) =>
    url.startsWith("file://") &&
    !url.includes("/node_modules/") &&
    [`${root}/sync-server/`, `${root}/shared/`].some((p) => fileURLToPath(url).startsWith(p));
  const procs: ProcessCov[] = [];
  const maps: Cache = {};
  for (const f of files) {
    const v8 = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as V8File;
    procs.push({ result: v8.result.filter((s) => ours(s.url)) });
    Object.assign(maps, v8["source-map-cache"]);
  }
  const resolve = (url: string): Resolved => {
    const local = fileURLToPath(url);
    const map = maps[url];
    // the placeholder: lines of the generated code's lengths, newline-joined
    return map
      ? {
          path: local,
          sources: {
            source: map.lineLengths.map((n) => "x".repeat(n)).join("\n"),
            sourceMap: { sourcemap: map.data as never },
          },
        }
      : { path: local, sources: { source: readFileSync(local, "utf8") } };
  };
  const merged = mergeProcessCovs(procs).result.filter((s) => existsSync(fileURLToPath(s.url)));
  return { measured: await convert(merged, (u) => resolve(u), root), processes: files.length };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root");
  const root =
    i > 0 ? path.resolve(process.argv[i + 1] ?? ".") : path.resolve(import.meta.dir, "..");
  const { measured, processes } = await serverCoverage(root);
  mkdirSync(path.join(root, ".verify/coverage"), { recursive: true });
  writeFileSync(path.join(root, ".verify/coverage/server.json"), JSON.stringify(measured));
  console.log(
    `server coverage: ${Object.keys(measured.files).length} files from ${processes} processes`,
  );
}
