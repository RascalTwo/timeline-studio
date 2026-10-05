// node regrade.ts -- re-score every saved run with the current grader, without calling any brain
// again (the frontier runs cost money; re-grading them should not). Only the local judge runs, and
// its verdicts are cached in judge-cache.json.
import { readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { grade, prepare } from "./score.ts"

const STATE = process.env.TS_ASSISTANT_STATE ?? `${homedir()}/.agents/state/timeline-studio-assistant`
const ds = Object.fromEntries(JSON.parse(readFileSync(`${STATE}/dataset.json`, "utf8")).map((x: any) => [x.id, x]))
const self = JSON.parse(readFileSync(`${STATE}/self_contained.json`, "utf8"))
const want = (process.argv[2] ?? "").split(",").filter(Boolean)

for (const f of readdirSync(`${STATE}/runs`).sort()) {
  if (want.length && !want.some(w => f.includes(w))) continue
  const rows = JSON.parse(readFileSync(`${STATE}/runs/${f}`, "utf8")).filter((r: any) => ds[r.id] && self[r.id]?.self_contained !== false)
  const out: Record<string, { n: number; right: number; wrong: number }> = {}
  for (const r of rows) {
    const it = ds[r.id]
    await prepare(it.gold, r.proposal, it.utterance, `${STATE}/judge-cache.json`)
    const g = grade(it.gold, r.proposal, it.utterance)
    const s = (out[it.split] ??= { n: 0, right: 0, wrong: 0 })
    s.n++; if (g === "right") s.right++; if (g === "wrong_act") s.wrong++
  }
  console.log(f.replace(/\.json$/, "").padEnd(58), Object.entries(out).map(([k, v]) => `${k} ${v.right}/${v.n} (${v.wrong} wrong)`).join("   "))
}
