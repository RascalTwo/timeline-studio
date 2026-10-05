// node eval.ts <brain> [llm] [--set build|heldout|all] [--resolver embed|systemone|overlap]
//   brain: hybrid | llm | rules      llm: ollama:gemma4:12b | splash:<model> ...
// Replays every request in $TS_ASSISTANT_STATE/dataset.json against the plan AS IT WAS when it was said, and
// prints the ship bar: right out of n, and confident wrong actions (must be 0).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { BRAINS } from "./brain.ts"
import { asOf } from "./plan.ts"
import { grade, prepare } from "./score.ts"

const args = process.argv.slice(2)
const flag = (f: string, d: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d }
const [brainName, llm] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"))
const set = flag("--set", "build"), resolver = flag("--resolver", "embed") as any
const brain = (BRAINS as any)[brainName]
if (!brain) { console.error("brain: hybrid | llm | rules"); process.exit(2) }

const cfg = JSON.parse(readFileSync(`${homedir()}/.config/timeline-studio/config.json`, "utf8"))
const doc = (await (await fetch(`${cfg.base}/api/plan`, { headers: { "x-timeline-token": cfg.token } })).json()).doc
// The dataset is the user's real plan: it lives outside the repo (client data never enters it).
const STATE = process.env.TS_ASSISTANT_STATE ?? `${homedir()}/.agents/state/timeline-studio-assistant`
const items = JSON.parse(readFileSync(`${STATE}/dataset.json`, "utf8"))
  .filter((x: any) => set === "all" || x.split === set)
  // Items a voice assistant cannot resolve without the conversation they were said in
  // (tagged blind to any brain's output; see self_contained.json).
  .filter((x: any) => { try { return JSON.parse(readFileSync(`${STATE}/self_contained.json`, "utf8"))[x.id]?.self_contained !== false } catch { return true } })

const rows: any[] = []
for (const it of items) {
  const t0 = performance.now()
  let p: any, err = ""
  try { p = await brain(it.utterance, asOf(doc, it.at), { llm, resolver, now: it.at }) }
  catch (e: any) { p = { kind: "none" }; err = String(e.message ?? e).slice(0, 120) }
  const ms = Math.round(performance.now() - t0)
  await prepare(it.gold, p, it.utterance, `${STATE}/judge-cache.json`)
  const g = grade(it.gold, p, it.utterance)
  rows.push({ id: it.id, kind: it.kind, grade: g, ms, proposal: p, err })
  console.log(`${g.padEnd(9)} ${String(ms).padStart(6)}ms  ${it.kind.padEnd(8)} ${it.utterance.slice(0, 70)}${err ? "  !! " + err : ""}`)
}
const n = rows.length, right = rows.filter(r => r.grade === "right").length
const wrongAct = rows.filter(r => r.grade === "wrong_act").length
const ms = rows.map(r => r.ms).sort((a, b) => a - b)
console.log(`\n${brainName}${llm ? " " + llm : ""} (${resolver}) on ${set}: ${right}/${n} right, ${wrongAct} confident wrong, ` +
  `median ${ms[n >> 1]}ms, p90 ${ms[Math.floor(n * 0.9)]}ms   bar: >= ${Math.ceil(n * 0.9)}/${n} and 0 confident wrong -> ` +
  (right >= Math.ceil(n * 0.9) && wrongAct === 0 ? "PASS" : "fail"))
mkdirSync(`${STATE}/runs`, { recursive: true })
writeFileSync(`${STATE}/runs/${brainName}-${(llm ?? "none").replace(/[:/]/g, "_")}-${resolver}-${set}.json`,
  JSON.stringify(rows, null, 1))
