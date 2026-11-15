// coverage-v8.ts — merged V8 script coverage → per-source line and branch hits. Shared by the page
// (coverage-page.ts, over CDP) and the server suite (coverage-server.ts, over NODE_V8_COVERAGE).
//
// MERGE BEFORE CONVERTING. V8 leaves out a block whose count equals its parent's, so two processes'
// ranges for one script do not line up, and merging them after conversion (or letting a reporter
// union them) makes a line's number depend on which process happened to split which block. Callers
// merge the raw ranges per script with @bcoe/v8-coverage first and hand the result here.

import type { ScriptCov } from "@bcoe/v8-coverage";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import v8toIstanbul from "v8-to-istanbul";
import type { FileCov, Measured } from "./coverage-floor.ts";

/** Where a script's code and source map are: `path` is the file it came from (or the bundle), `sources`
 *  what v8-to-istanbul is told about it. null = the script maps to nothing we can find. */
export type Resolved = { path: string; sources: Parameters<typeof v8toIstanbul>[2] } | null;

export async function convert(
  scripts: ScriptCov[],
  resolve: (url: string) => Resolved,
  root: string,
): Promise<Measured> {
  const files: Record<string, FileCov> = {};
  const unmapped: string[] = [];
  for (const s of scripts) {
    const r = resolve(s.url);
    if (!r) {
      unmapped.push(s.url);
      continue;
    }
    const conv = v8toIstanbul(r.path, 0, r.sources);
    await conv.load();
    conv.applyCoverage(s.functions);
    const data = conv.toIstanbul();
    let any = false;
    for (const [file, d] of Object.entries(data)) {
      if (!existsSync(file)) continue; // a virtual module (rolldown runtime, preload helper) has no file
      any = true;
      const cov = (files[path.relative(root, realpathSync(file))] ??= { lines: {}, branches: [] });
      for (const [id, st] of Object.entries(d.statementMap))
        cov.lines[st.start.line] = Math.max(cov.lines[st.start.line] ?? 0, d.s[id] ?? 0);
      for (const [id, br] of Object.entries(d.branchMap))
        for (const [k, loc] of br.locations.entries())
          cov.branches.push([loc.start.line, d.b[id]?.[k] ?? 0]);
    }
    if (!any) unmapped.push(s.url);
  }
  return { files, unmapped };
}
