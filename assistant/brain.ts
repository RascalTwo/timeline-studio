// Sentence in, proposed commands out. The brain never writes to a plan: the client applies
// what it proposes (the page through its own apply path, so undo works). Three brains, so the
// eval can say which one earns its RAM:
//   hybrid  the LLM only PARSES the sentence into a frame; tasks are resolved by the scorer,
//           so the LLM never sees the task list and can never invent a task id
//   llm     the LLM sees the task list and writes commands itself
//   rules   no model: keyword patterns + word overlap. The falsifier.
import { llmJson, embed, cosine, choose, ollamaTools } from "./models.ts"
import { type Plan, type Task, isDone } from "./plan.ts"
import type { Proposal } from "./score.ts"

export type Opts = { llm?: string; resolver?: "embed" | "systemone" | "overlap"; now: string }
const LETTERS = "ABCD"

// ---------------------------------------------------------------- the frame the LLM fills

const FRAME_PROMPT = `You turn one spoken request about a personal task plan into JSON. The speech was
dictated, so words may be misheard. Reply with ONLY {"actions": [...]}, one object per change, using:
{"action":"add","label":"<new task name, cleaned up>","minutes":<number or null>,"project":"<project named, or null>","waits_for":"<words naming an existing task it waits on, or null>","due":"<YYYY-MM-DD or null>","started":<true if the user says it is already in progress>}
{"action":"rename","task":"<words naming the existing task>","label":"<new name>"}
{"action":"duration","task":"...","minutes":<number>}
{"action":"due","task":"...","date":"YYYY-MM-DD" or null}   (null REMOVES the deadline: "doesn't need to be done by then")
{"action":"link","task":"<the task that must wait>","waits_for":"<the task it waits on>"}
{"action":"start","task":"..."}   {"action":"finish","task":"..."}   {"action":"signoff","task":"..."}
{"action":"comment","task":"...","text":"<the note>"}
{"action":"reorder","task":"...","position":"top" | "bottom"}
{"action":"query","about":"next" | "blocked" | "due"}
"task" and "waits_for" are the user's own words for an EXISTING task; copy them, do not invent ids. When one
change applies to several named tasks ("all the bill pays"), "task" may be a list of phrases.
Rules:
- One idea described at length is ONE add, however many sentences it takes. Several adds only when the
  user clearly lists separate tasks ("two tasks: ... and ...").
- "label" is a short task name (under 10 words) in plain words, not a copy of the whole ramble.
- "minutes" only when the user says how LONG the work takes ("should take an hour"); times like
  "10 minutes ago", "at 5pm", "by Monday" are NOT durations.
- start/finish/signoff/comment/link only when the user asks for exactly that; describing a problem is an add.
- "add/create/make a task", "a bug report", "put a pin in it", "we'll need a task", "another idea" = add, never comment.
- A label names the WORK ("Add tests to the QR generator viz"), never the container ("timeline studio task").
  Project names (Timeline Studio, AI, Work, Personal...) go in "project", not in the label.
- Parts of one deliverable said together ("the diagram and the document") are one task.
- When the user lists several tasks ("one... another... also... both of those... those three"), emit one add
  PER task and drop none, even when the list is long or rambling.
- A label must say WHAT the work is about on its own: "Plug the pairwise sorter into Timeline Studio",
  never "Plug into Timeline Studio"; keep the subject (the thing being changed) in every label.
- "pick up X", "take X", "start on X", "set its started date" = start. "already did it", "already done",
  "forgot to mark it done", "call that one done" = finish. A new task the user says they are picking up or
  starting now gets "started": true.
- Minutes: an hour = 60, half an hour = 30, a day = 1440. "sign off on"/"refine" = signoff. "done"/"finished" = finish.`

async function frame(llm: string, utterance: string, now: string) {
  const f = await llmJson(llm, FRAME_PROMPT, `Today is ${now.slice(0, 10)}.\nRequest: ${utterance}`)
  // Small models often return the bare action object instead of {"actions":[...]}: accept both.
  return Array.isArray(f.actions) ? f.actions : Array.isArray(f) ? f : f?.action ? [f] : []
}

// ---------------------------------------------------------------- resolving "the dentist thing"

type Ranked = { task: Task; conf: number }[]

/** Rank existing tasks against the user's words for one. Finish/start look at open tasks only. */
async function resolve(words: string, plan: Plan, action: string, opts: Opts): Promise<Ranked> {
  const pool = plan.tasks.filter(t => (action === "finish" || action === "start") ? !isDone(t) : true)
  if (!pool.length || !words) return []
  if (opts.resolver === "overlap") return overlapRank(words, pool)
  const [q, ...labs] = await embed([words, ...pool.map(t => t.label)])
  const sims = labs.map(v => cosine(q, v))
  const order = sims.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, 8)
  // softmax over the top 8 at a sharp temperature: a clear winner gets most of the mass
  const ex = order.map(([s]) => Math.exp((s - order[0][0]) / 0.02)), z = ex.reduce((a, b) => a + b, 0)
  let ranked = order.map(([, i], k) => ({ task: pool[i], conf: ex[k] / z }))
  if (opts.resolver === "systemone") {
    const c = await choose(`Tasks:\n${ranked.map(r => r.task.label).join("\n")}`,
      `Which task is "${words}"?`, ranked.map(r => r.task.label))
    const top = ranked[c.pick]
    ranked = [{ ...top, conf: Math.max(top.conf, c.probs[c.pick] || 0) }, ...ranked.filter(r => r !== top)]
  }
  return ranked
}

const STOP = new Set("the a an to of and for on in my me i it that this with is be up x do task".split(" "))
const toks = (s: string) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => !STOP.has(w))
function overlapRank(words: string, pool: Task[]): Ranked {
  const w = new Set(toks(words))
  const sc = pool.map(t => { const l = toks(t.label); return l.length ? l.filter(x => w.has(x)).length / Math.sqrt(l.length) : 0 })
  const order = sc.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, 8).filter(([s]) => s > 0)
  const z = order.reduce((a, [s]) => a + s, 0) || 1
  return order.map(([s, i]) => ({ task: pool[i], conf: s / z }))
}

// ---------------------------------------------------------------- frame -> commands

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task"
const ACT_AT = 0.6          // below this confidence in a task, ask instead of acting
const CONFIRM = new Set(["finish", "rename"])   // Q3: destructive-ish, confirm even when sure

function command(a: any, id: string, plan: Plan, now: string, dep?: string): any[] {
  switch (a.action) {
    case "rename": return [{ type: "renameTask", id, label: a.label }]
    case "duration": return [{ type: "setDuration", id, dur: Math.round(a.minutes) }]
    case "due": return [{ type: "setDue", id, due: a.date ? `${a.date}T17:00:00.000Z` : null }]
    case "link": return dep ? [{ type: "addDep", id, dep }] : []
    case "start": return [{ type: "startTask", id }]
    case "finish": return [{ type: "finishTask", id }]
    case "signoff": return [{ type: "setRefined", id, refinedAt: now }]
    case "comment": return [{ type: "addComment", id, comment: { id: `c-${Date.parse(now).toString(36)}`, text: a.text } }]
    case "reorder": return [{ type: "moveTaskInLane", id, toIndex: a.position === "bottom" ? 9999 : 0 }]
  }
  return []
}

async function fromFrame(actions: any[], plan: Plan, opts: Opts): Promise<Proposal> {
  const cmds: any[] = []
  const added: { id: string; label: string }[] = []   // "after that task" may mean one added just now
  const sameBatch = (w: string) => added.find(t => {
    const a = new Set(toks(w)), l = toks(t.label); return l.length && l.filter(x => a.has(x)).length / l.length >= 0.5 })
  let confirm = false
  for (const a of actions) {
    if (a.action === "query") return { kind: "answer", text: `query:${a.about}` }
    if (a.action === "add") {
      const deps: string[] = []
      if (a.waits_for) {
        const mine = sameBatch(a.waits_for)
        const r = mine ? [] : await resolve(a.waits_for, plan, "link", opts)
        if (mine) deps.push(mine.id); else if (r[0]) deps.push(r[0].task.id)
      }
      const proj = a.project ? plan.colors.find(c => toks(c.label).some(w => toks(a.project).includes(w))) : undefined
      const id = `${slug(a.label ?? "")}-${Date.parse(opts.now).toString(36).slice(-4)}`
      cmds.push({ type: "addTask", task: { id, label: a.label, dur: a.minutes ? Math.round(a.minutes) : 60,
        ...(proj ? { color: [proj.id] } : {}), ...(deps.length ? { deps } : {}) } })
      if (a.due) cmds.push({ type: "setDue", id, due: `${a.due}T17:00:00.000Z` })
      if (a.started) cmds.push({ type: "startTask", id })
      added.push({ id, label: a.label ?? "" })
      continue
    }
    if (Array.isArray(a.task)) {            // one change, several named tasks: each resolved on its own
      for (const t of a.task) {
        const r = await resolve(String(t), plan, a.action, opts)
        if (r[0]) { cmds.push(...command(a, r[0].task.id, plan, opts.now)); if (r[0].conf < ACT_AT) confirm = true }
      }
      continue
    }
    const r = await resolve(a.task ?? "", plan, a.action, opts)
    if (!r.length) return { kind: "none", text: `no task matches "${a.task}"` }
    let dep: string | undefined
    if (a.action === "link") {
      const w = await resolve(a.waits_for ?? "", plan, "link", opts)
      dep = w.find(x => x.task.id !== r[0].task.id)?.task.id
    }
    if (r[0].conf < ACT_AT && actions.length === 1) {
      return { kind: "ask", options: r.slice(0, 3).map((x, k) => ({
        letter: LETTERS[k], label: x.task.label, cmds: command(a, x.task.id, plan, opts.now, dep) })) }
    }
    cmds.push(...command(a, r[0].task.id, plan, opts.now, dep))
    if (CONFIRM.has(a.action) || r[0].conf < ACT_AT) confirm = true
  }
  if (!cmds.length) return { kind: "none" }
  return { kind: confirm ? "confirm" : "act", cmds }
}

// ---------------------------------------------------------------- the three brains

export async function hybrid(utterance: string, plan: Plan, opts: Opts): Promise<Proposal> {
  return fromFrame(await frame(opts.llm!, utterance, opts.now), plan, opts)
}

const LLM_PROMPT = (plan: Plan) => `You turn one spoken request into Timeline Studio commands. Reply ONLY with {"commands": [...]}.
Commands: {"type":"addTask","task":{"id":"<new-slug>","label":"...","dur":<minutes>,"deps":["<id>"]}},
{"type":"renameTask","id","label"}, {"type":"setDuration","id","dur"}, {"type":"setDue","id","due":"<ISO>"},
{"type":"addDep","id":"<task that waits>","dep":"<task it waits on>"},
{"type":"startTask","id"} (start working on it), {"type":"finishTask","id"} (it is done),
{"type":"setRefined","id","refinedAt":"<ISO>"} (sign off), {"type":"addComment","id","comment":{"id":"c1","text":"..."}},
{"type":"moveTaskInLane","id","toIndex":0}. Use ONLY ids from this list:
${plan.tasks.map(t => `${t.id} | ${t.label}${isDone(t) ? " (done)" : ""}`).join("\n")}`

export async function llmOnly(utterance: string, plan: Plan, opts: Opts): Promise<Proposal> {
  const out = await llmJson(opts.llm!, LLM_PROMPT(plan), `Now is ${opts.now}.\nRequest: ${utterance}`)
  const cmds = Array.isArray(out.commands) ? out.commands : []
  return cmds.length ? { kind: "act", cmds } : { kind: "none" }
}

const RULES: [string, RegExp][] = [
  ["signoff", /\b(sign(ed)?[ -]?off|refine[sd]?)\b/i], ["finish", /\b(done|finish(ed)?|complete[d]?)\b/i],
  ["start", /\b(start(ed|ing)?|begin|working on)\b/i], ["link", /\b(wait(s|ing)? (for|on)|depends on|blocked by|after)\b/i],
  ["comment", /\b(comment|note)\b/i], ["rename", /\brename\b/i], ["due", /\bdue\b/i],
  ["duration", /\b(take[s]?|estimate)\b.*\b(hour|minute|day)s?\b/i],
]

export async function rules(utterance: string, plan: Plan, opts: Opts): Promise<Proposal> {
  const hit = RULES.find(([, re]) => re.test(utterance))
  const n = utterance.match(/(\d+(?:\.\d+)?|an?|half an?)\s*(hour|minute|day)s?/i)
  const minutes = n ? (({ hour: 60, minute: 1, day: 1440 } as any)[n[2].toLowerCase()] *
    (/half/i.test(n[1]) ? 0.5 : /^an?$/i.test(n[1]) ? 1 : Number(n[1]))) : null
  if (!hit) return fromFrame([{ action: "add", label: utterance.replace(/^(add|create|remind me to|i need to|i should)\s+/i, ""), minutes }], plan, { ...opts, resolver: "overlap" })
  return fromFrame([{ action: hit[0], task: utterance, waits_for: utterance.split(/wait(?:s|ing)? (?:for|on)|after|depends on|blocked by/i)[1], minutes }],
    plan, { ...opts, resolver: "overlap" })
}



// ---------------------------------------------------------------- the tool-calling brain
// What Claude Code does that a one-shot call cannot: LOOK before acting. The model searches the plan,
// sees real ids and names, then calls action tools. Nothing it calls touches the plan: action calls
// are collected as the proposal. An action on an existing task must use an id a search returned, so
// an invented id comes back to the model as an error instead of reaching the plan.

const fn = (name: string, description: string, props: Record<string, any>, required: string[] = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties: props, required } } })
const ID = { type: "string", description: "a task id returned by search_tasks" }
const TOOLS = [
  fn("search_tasks", "Find existing tasks by the user's words for them. Returns up to 8 {id, label, status}. Call this before any action on an existing task.", { query: { type: "string" } }, ["query"]),
  fn("add_task", "Create one new task. Call once PER task the user asks for; drop none.", {
    label: { type: "string", description: "short name that says what the work is about, subject included" },
    minutes: { type: "number", description: "only if the user says how long the work takes (an hour = 60, a day = 1440)" },
    project: { type: "string", description: "project the user names, if any" },
    waits_for: { type: "string", description: "id of an existing task this one waits for, OR the exact label of a task added earlier in this request" },
    due: { type: "string", description: "YYYY-MM-DD if the user gives a deadline" },
    started: { type: "boolean", description: "true if the user says they are starting / picking it up now" } }, ["label"]),
  fn("start_task", "Mark a task started ('pick up', 'start on', 'take').", { id: ID }, ["id"]),
  fn("finish_task", "Mark a task done ('done', 'finished', 'already did it').", { id: ID }, ["id"]),
  fn("rename_task", "Rename a task.", { id: ID, label: { type: "string" } }, ["id", "label"]),
  fn("set_minutes", "Set how long a task takes.", { id: ID, minutes: { type: "number" } }, ["id", "minutes"]),
  fn("set_due", "Set or clear (date null) a deadline.", { id: ID, date: { type: ["string", "null"], description: "YYYY-MM-DD or null" } }, ["id"]),
  fn("link_tasks", "Make one task wait for another.", { id: { ...ID, description: "the task that waits" }, waits_for: { ...ID, description: "the task it waits for" } }, ["id", "waits_for"]),
  fn("comment", "Add a note to a task.", { id: ID, text: { type: "string" } }, ["id", "text"]),
  fn("sign_off", "The user signs off on / refines a task.", { id: ID }, ["id"]),
  fn("move_task", "Reorder a task to the top or bottom.", { id: ID, position: { type: "string", enum: ["top", "bottom"] } }, ["id", "position"]),
  fn("answer_question", "The user asks what's next, what's blocked, or what's due.", { about: { type: "string", enum: ["next", "blocked", "due"] } }, ["about"]),
]
const TOOL_PROMPT = `You manage a personal task plan by calling tools. The request was dictated, so words may be misheard.
Search for any existing task before acting on it. Create exactly the tasks the user asks for, one add_task each.
Make only the changes the user asks for. When you have made every change, reply with a short sentence and no tool call.`
const ACTION_OF: Record<string, string> = { start_task: "start", finish_task: "finish", rename_task: "rename", set_minutes: "duration",
  set_due: "due", link_tasks: "link", comment: "comment", sign_off: "signoff", move_task: "reorder" }

export async function tools(utterance: string, plan: Plan, opts: Opts): Promise<Proposal> {
  const model = opts.llm!.replace(/^ollama:/, "")
  const messages: any[] = [{ role: "system", content: `${TOOL_PROMPT}\nToday is ${opts.now.slice(0, 10)}.` },
    { role: "user", content: utterance }]
  const seen = new Set<string>(), cmds: any[] = [], added: { id: string; label: string }[] = []
  let confirm = false
  for (let turn = 0; turn < 6; turn++) {
    const msg = await ollamaTools(model, messages, TOOLS)
    messages.push(msg)
    const calls = msg.tool_calls ?? []
    if (!calls.length) break
    for (const c of calls) {
      const name = c.function.name, a = c.function.arguments ?? {}
      let result: any = "ok"
      if (name === "search_tasks") {
        const r = await resolve(String(a.query ?? ""), plan, "search", opts)
        r.forEach(x => seen.add(x.task.id))
        result = r.map(x => ({ id: x.task.id, label: x.task.label, status: isDone(x.task) ? "done" : x.task.actualStart ? "started" : "not started" }))
      } else if (name === "answer_question") {
        return { kind: "answer", text: `query:${a.about}` }
      } else if (name === "add_task") {
        const id = `${slug(a.label ?? "")}-${Date.parse(opts.now).toString(36).slice(-4)}-${added.length}`
        const mine = added.find(t => t.label === a.waits_for)?.id
        const dep = mine ?? (a.waits_for && plan.tasks.some(t => t.id === a.waits_for) ? a.waits_for : undefined)
        const proj = a.project ? plan.colors.find(k => toks(k.label).some(w => toks(String(a.project)).includes(w))) : undefined
        cmds.push({ type: "addTask", task: { id, label: a.label, dur: a.minutes ? Math.round(a.minutes) : 60,
          ...(proj ? { color: [proj.id] } : {}), ...(dep ? { deps: [dep] } : {}) } })
        if (a.due) cmds.push({ type: "setDue", id, due: `${a.due}T17:00:00.000Z` })
        if (a.started) cmds.push({ type: "startTask", id })
        added.push({ id, label: a.label }); result = { id }
      } else if (ACTION_OF[name]) {
        const known = (x: string) => seen.has(x) || added.some(t => t.id === x)
        if (!known(a.id) || (name === "link_tasks" && !known(a.waits_for))) {
          result = { error: "unknown id: call search_tasks and use an id it returned" }
        } else {
          cmds.push(...command({ ...a, action: ACTION_OF[name], text: a.text, date: a.date, minutes: a.minutes }, a.id, plan, opts.now, a.waits_for))
          if (CONFIRM.has(ACTION_OF[name])) confirm = true
        }
      } else result = { error: `no tool ${name}` }
      messages.push({ role: "tool", content: JSON.stringify(result) })
    }
  }
  if (!cmds.length) return { kind: "none" }
  return { kind: confirm ? "confirm" : "act", cmds }
}

export const BRAINS = { hybrid, llm: llmOnly, rules, tools }
