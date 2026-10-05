// Does a proposal match the gold commands? Strict on what the user SAID, blind to what Claude
// guessed: a duration only counts when the utterance names one, a project never counts.

// Content words only. Rascal Two, calibrating the grader: "Plug into Timeline Studio -- what does that even
// mean? It needs to say pairwise sorter." Filler and project names ("into", "Timeline Studio") had
// carried that name past the overlap check on half its words while saying nothing about the work.
const FILLER = new Set(("a an the to of for in on into onto at by with and or from this that it its is be " +
  "add task timeline studio ai work personal misc home setup").split(" "))
const words = (s?: string) => new Set(((s ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !FILLER.has(w)))
/** Share of the gold label's words the predicted label kept (dictated labels get reworded). */
export const labelSim = (gold: string, pred: string) => {
  const g = words(gold), p = words(pred)
  return g.size ? [...g].filter(w => p.has(w)).length / g.size : 0
}
/** Meaning, for labels reworded beyond shared words. Filled by the caller before grading (it needs
 *  embeddings, which are async): cosine of nomic-embed-text vectors. Calibrated on 8 pairs:
 *  same task 0.75-0.88, different tasks 0.39-0.45, so 0.65 sits in the gap. */
export const semantic = new Map<string, number>()
const SEMANTIC_AT = 0.65
/** A local judge's verdict on names neither words nor embeddings could match: "given what the user
 *  said, do these two names describe the same work?" Filled by `prepare`, cached on disk. The
 *  frontier test showed why it is needed: Opus 5.5's "Plan summary should count only open work"
 *  failed against gold "Whole plan counts finished work, so it cannot say how much is left". */
export const judged = new Map<string, boolean>()
const labelOk = (gold?: string, pred?: string, words = 0.5) =>
  labelSim(gold ?? "", pred ?? "") >= words || (semantic.get(`${gold}\u0000${pred}`) ?? 0) >= SEMANTIC_AT ||
  judged.get(`${gold}\u0000${pred}`) === true
/** Every (gold label, predicted label) pair a grade could compare, so the caller can embed them. */
export function labelPairs(gold: any[], preds: any[][]): [string, string][] {
  const gl = gold.flatMap(g => [g.task?.label ?? g.label, descHead(g.task?.desc)]).filter(Boolean)
  const pl = preds.flat().map(p => p?.task?.label ?? p?.label).filter(Boolean)
  return gl.flatMap(a => pl.map(b => [a, b] as [string, string]))
}
/** A gold description's opening, where Claude restated what the user meant in plain words. */
const descHead = (d?: string) => d ? d.replace(/\s+/g, " ").slice(0, 240) : ""
// Pre-v6 plans stored dates as day numbers counted from 2026-09-19.
const day = (s?: string | number | null) => typeof s === "number"
  ? new Date(Date.UTC(2026, 8, 19) + Math.floor(s) * 86400000).toISOString().slice(0, 10) : (s ?? "").slice(0, 10)
// Only a stated LENGTH of work: "should take an hour", "15 minute durations". A time that is part of
// a name ("the 30 minute sync") or a count ("89 tasks", "8 a.m.") is not one, and demanding
// Claude's guessed minutes there failed correct adds.
const N = String.raw`(\d+(\.\d+)?|an?|one|two|three|four|five|half an?|fifteen|thirty)[\s-]*(hours?|hrs?|minutes?|mins?|days?|weeks?)`
const SAYS_TIME = new RegExp(String.raw`\b(take|takes|taking|took|duration|estimate|should be|about|around|like)\b[^.?!]{0,25}?\b${N}\b|\b${N}\s+(durations?|of work|job|task)\b`, "i")

// Gold links and dates Claude filled in from the conversation, not from the words, are not demanded:
// only when the sentence itself states a relation or a date.
const SAYS_LINK = /\b(after|before|wait(s|ing)? (on|for)|depends? on|blocked by|blocker|block(s|ing)?|follow[- ]up|first|then)\b/i
const SAYS_DATE = /\b(due|by|deadline|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|today|next week|\d{1,2}\s*(a\.?m\.?|p\.?m\.?)|\d{1,2}(st|nd|rd|th))\b/i

function same(g: any, p: any, utterance: string): boolean {
  if (g.type !== p.type) return false
  switch (g.type) {
    case "addTask": {
      const gt = g.task, pt = p.task ?? {}
      // A new task's name is judged by meaning: against the gold name, or the gold description
      // (Claude's names often reframe what was said; the description usually restates it).
      if (!labelOk(gt.label, pt.label) && !((semantic.get(`${descHead(gt.desc)}\u0000${pt.label}`) ?? 0) >= 0.65)) return false
      if (gt.dur != null && SAYS_TIME.test(utterance) && pt.dur !== gt.dur) return false
      const gd = [...(gt.deps ?? [])].sort().join(), pd = [...(pt.deps ?? [])].sort().join()
      if (gd && gd !== pd && SAYS_LINK.test(utterance)) return false
      if (gt.due && day(gt.due) !== day(pt.due) && SAYS_DATE.test(utterance)) return false
      return !!gt.actualStart === !!pt.actualStart && !!gt.actualEnd === !!pt.actualEnd
    }
    case "renameTask": return g.id === p.id && labelOk(g.label, p.label, 0.6)
    case "setDuration": return g.id === p.id && g.dur === p.dur
    case "setDue": return g.id === p.id && day(g.due) === day(p.due)
    case "addDep": return g.id === p.id && g.dep === p.dep
    case "setActuals": return g.id === p.id && !!g.actualEnd === !!p.actualEnd && !!g.actualStart === !!p.actualStart
    case "moveTaskInLane": return g.id === p.id
    default: return g.id === p.id        // addComment, setRefined, setTaskDesc: right target is what matters
  }
}

/** Fold a due date or start aimed at a task added in the SAME batch into that task. Gold and a brain
 *  name a new task differently (Claude's id vs a generated slug), and gold sometimes carries the due
 *  date inside the task, sometimes as its own command; after folding both say the same thing. */
function fold(cmdsIn: any[]): any[] {
  // THE GOLD PREDATES v8, when start and finish were one `setActuals`; read the session commands as it.
  const cmds = cmdsIn.map(c => c.type === "startTask" ? { type: "setActuals", id: c.id, actualStart: "now", actualEnd: null }
    : c.type === "finishTask" ? { type: "setActuals", id: c.id, actualStart: "now", actualEnd: "now" } : c)
  const added = new Map(cmds.filter(c => c.type === "addTask").map(c => [c.task?.id, { ...c, task: { ...c.task } }]))
  // A link to a task created in the same batch names it by that side's own new id ("macos-tahoe-26-7"
  // vs "update-macos"): compare it as "the Nth task added here" instead.
  const nth = new Map([...added.keys()].map((id, i) => [id, `@new${i}`]))
  for (const c of added.values()) if (c.task.deps) c.task.deps = c.task.deps.map((d: string) => nth.get(d) ?? d)
  const out: any[] = []
  for (const c of cmds) {
    const t = added.get(c.id)?.task
    if (c.type === "addTask") out.push(added.get(c.task?.id))
    else if (c.type === "addDep" && (added.has(c.id) || nth.has(c.dep))) {
      const tt = added.get(c.id)?.task
      if (tt) tt.deps = [...(tt.deps ?? []), nth.get(c.dep) ?? c.dep]
      else out.push({ ...c, dep: nth.get(c.dep) ?? c.dep })
    }
    else if (t && c.type === "setDue") t.due = c.due
    else if (t && c.type === "setActuals") { t.actualStart = c.actualStart; t.actualEnd = c.actualEnd }
    else out.push(c)
  }
  return out
}

/** Every gold command matched by a distinct predicted one, and no predicted command left over. */
export function matches(goldIn: any[], predIn: any[], utterance: string): boolean {
  const gold = fold(goldIn), pred = fold(predIn)
  const left = [...pred]
  for (const g of gold) {
    const i = left.findIndex(p => same(g, p, utterance))
    if (i < 0) return false
    left.splice(i, 1)
  }
  // A comment left over is harmless: Opus often filed the details of a rambling request as a comment
  // on the task it created, which is helpful, not wrong.
  return left.every(p => p.type === "addComment")
}

/** Fill `semantic` (embeddings) and `judged` (local LLM, disk-cached) for every name pair this grade
 *  could compare, so the synchronous matcher can read them. */
export async function prepare(gold: any[], p: Proposal, utterance: string, cacheFile: string) {
  const { embed, cosine, llmJson } = await import("./models.ts")
  const { readFileSync, writeFileSync, existsSync } = await import("node:fs")
  const cache: Record<string, boolean> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {}
  const pairs = labelPairs(gold, [p.cmds ?? [], ...(p.options ?? []).map(o => o.cmds)])
  let dirty = false
  for (const [a, b] of pairs) {
    const k = `${a}\u0000${b}`
    if (!semantic.has(k)) { const [x, y] = await embed([a, b]); semantic.set(k, cosine(x, y)) }
    if (labelSim(a, b) >= 0.5 || semantic.get(k)! >= SEMANTIC_AT) continue
    if (!(k in cache)) {
      const v = await llmJson(JUDGE, JUDGE_PROMPT, `The user said: "${utterance.slice(0, 700)}"\nName A: ${a}\nName B: ${b}`)
      cache[k] = v.same === true; dirty = true
    }
    judged.set(k, cache[k])
  }
  if (dirty) writeFileSync(cacheFile, JSON.stringify(cache, null, 1))
}
const JUDGE = process.env.JUDGE_LLM ?? "ollama:gemma4:12b"
const JUDGE_PROMPT = `You judge whether two names for a task in a to-do plan describe the SAME piece of work, given what the
user said. Wording, framing (a problem vs. its fix), and detail level may differ; what matters is whether
someone doing task A would have done task B.
BUT name B must stand on its own: read with no other context, it must say WHAT the work is about. A name
too vague to identify the work ("Plug into Timeline Studio" when the work is plugging in the pairwise
sorter; "Fix the bug"; "Update the thing") is NOT the same, even if it is not wrong.
Reply ONLY {"same": true} or {"same": false}.`

export type Proposal = { kind: "act" | "confirm" | "ask" | "answer" | "none"; cmds?: any[];
  options?: { letter: string; label: string; cmds: any[] }[]; text?: string }

/** right: acted (or asked to confirm) with the right commands, or asked with the right one among
 *  the options. wrong_act: acted without asking and got it wrong -- the failure the bar forbids. */
export function grade(gold: any[], p: Proposal, utterance: string) {
  if (p.kind === "act" || p.kind === "confirm")
    return matches(gold, p.cmds ?? [], utterance) ? "right" : (p.kind === "act" ? "wrong_act" : "wrong_ask")
  if (p.kind === "ask")
    return (p.options ?? []).some(o => matches(gold, o.cmds, utterance)) ? "right" : "wrong_ask"
  return "missed"
}
