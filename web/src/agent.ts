// THE PLAN'S CHAT AGENT. A local model (Ollama, gemma4:12b by default) with tools that are thin wrappers
// around what this page can already do: read the plan it holds, ask the scheduler (`/api/ready`), and
// write through `call("commands")`, the same batch path as every other edit. It runs IN THE PAGE: no
// brain server, and the plan's token never leaves the tab it was already in.
//
// Why tools and not the earlier one-shot "frame" brain: Rascal Two used both and found the frame brain too
// narrow ("it doesn't empower the LLM"). With tools the model can look things up before acting, ask back
// in the chat, and answer free-form questions about the plan.
//
// Every write in a reply is recorded with the command that reverses it, so the whole reply can be undone.
import type { Command } from "../../shared/commands.js";
import { todayISO, zoneOf, statusOf, actualsOf } from "./schedule.js";

export const MODEL = localStorage.getItem("agentModel") ?? "gemma4:12b";
const OLLAMA = localStorage.getItem("ollamaUrl") ?? "http://127.0.0.1:11434";

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: any[] };
export type Ctx = { getDoc: () => any; call: (path: string, body?: unknown) => Promise<any>;
  /** Each change, in words, plus the task it touched (so the chat can offer to open it). */
  onAction: (text: string, taskId?: string) => void;
  /** HUMAN IN THE LOOP: show a change the model may not make by itself, as a card with Approve/Reject.
   *  Nothing is written unless the user clicks; the chat applies it and tells the model what was decided. */
  requestApproval: (req: Approval) => void };

export type Approval = { title: string; detail?: string; confirm: string; cmds: any[]; taskId?: string; done: string };

const fn = (name: string, description: string, properties: Record<string, any>, required: string[] = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
const ID = { type: "string", description: "a task id from search_tasks" };
const TOOLS = [
  fn("search_tasks", "Find tasks by what they are about (meaning, not exact words). Returns up to 8 with id, name, project, status.",
    { query: { type: "string" }, include_done: { type: "boolean", description: "also search finished tasks" } }, ["query"]),
  fn("get_task", "Everything about one task: description, minutes, due, status, what it waits for, what waits for it, recent comments.", { id: ID }, ["id"]),
  fn("plan_overview", "The scheduler's view of the plan.", { about: { type: "string", enum: ["next", "in_progress", "blocked", "due", "recently_done"] } }, ["about"]),
  fn("add_task", "Create ONE task. Call it once per task.", {
    label: { type: "string", description: "short name that says what the work is about" },
    minutes: { type: "number", description: "how long the work takes, only if the user said (an hour = 60)" },
    project: { type: "string", description: "project name, if the user gave one" },
    description: { type: "string" },
    waits_for: { type: "array", items: { type: "string" }, description: "ids of tasks this one waits for" },
    due: { type: "string", description: "YYYY-MM-DD" },
    started: { type: "boolean", description: "the user is starting it now" } }, ["label"]),
  fn("update_task", "Change an existing task. Only pass the fields to change.", {
    id: ID, label: { type: "string" }, minutes: { type: "number" }, description: { type: "string" },
    due: { type: ["string", "null"], description: "YYYY-MM-DD, or null to remove the deadline" },
    status: { type: "string", enum: ["started", "paused", "done"] },
    signed_off: { type: "boolean", description: "the user signs off on (refines) this task" } }, ["id"]),
  fn("link_tasks", "Make one task wait for another.", { id: { ...ID, description: "the task that waits" }, waits_for: { ...ID, description: "the task it waits for" } }, ["id", "waits_for"]),
  fn("comment_task", "Add a comment to a task.", { id: ID, text: { type: "string" } }, ["id", "text"]),
  fn("move_task", "Move a task to the top or bottom of its lane.", { id: ID, position: { type: "string", enum: ["top", "bottom"] } }, ["id", "position"]),
  fn("delete_task", "Ask Rascal Two to delete a task. This does NOT delete it: he must press Delete on the card it shows. Say that you asked; never say it is deleted.",
    { id: ID, reason: { type: "string", description: "why, in a few words" } }, ["id"]),
];

export function systemPrompt(doc: any): Msg {
  const projects = (doc.colors ?? []).map((c: any) => c.label).join(", ");
  return { role: "system", content: `You are the assistant inside Rascal Two's task plan (Timeline Studio). He types or dictates requests,
so words may be misheard. Use the tools to look things up and make changes; never guess an id.
- Before changing an existing task, find it with search_tasks. If two tasks could be meant, ask him which.
- Create exactly the tasks he asks for, one add_task each. A name must say what the work is about.
- Only change what he asks for. Deleting needs his click: call delete_task, then tell him to confirm on the card.
- After acting, reply in one or two short sentences saying what you did. Answer questions from tool results.
- Plain text only: no markdown, no asterisks, no headings (the chat does not render them).
Today is ${todayISO(doc)}. Projects: ${projects}.` };
}

// ---------------------------------------------------------------- tool implementations

// THE PAGE HAS NO UNDO -- only Revert, a room-wide discard of everything unsaved -- so the agent keeps its
// own: before each write it computes the command that puts the change back, from the plan as it stands.
/** The command that puts one change back, read off the plan BEFORE the change is applied. */
export function inverse(c: any, doc: any, laneOrder: string[]): Command[] {
  const t = doc.tasks.find((x: any) => x.id === c.id);
  switch (c.type) {
    case "addTask": return [{ type: "removeTask", id: c.task.id } as Command];
    // removeTask also strips the id from every other task's deps, so putting it back is the whole task
    // AND a re-link from everything that waited on it.
    case "removeTask": return t ? [{ type: "addTask", task: JSON.parse(JSON.stringify(t)) } as Command,   // JSON: the page's tasks are not structured-cloneable
      ...doc.tasks.filter((x: any) => x.deps?.includes(t.id)).map((x: any) => ({ type: "addDep", id: x.id, dep: t.id } as Command))] : [];
    case "renameTask": return t ? [{ type: "renameTask", id: c.id, label: t.label } as Command] : [];
    case "setDuration": return t ? [{ type: "setDuration", id: c.id, dur: t.dur } as Command] : [];
    case "setDue": return t ? [{ type: "setDue", id: c.id, due: t.due ?? null } as Command] : [];
    case "addDep": return t && !(t.deps ?? []).includes(c.dep) ? [{ type: "removeDep", id: c.id, dep: c.dep } as Command] : [];
    // Work once recorded stays recorded (ADR 0016), so these undo the state, not the sessions.
    case "startTask": return [{ type: "stopTask", id: c.id } as Command];
    case "stopTask": return [{ type: "startTask", id: c.id } as Command];
    case "finishTask": return [{ type: "reopenTask", id: c.id } as Command];
    case "reopenTask": return [{ type: "finishTask", id: c.id } as Command];
    case "setRefined": return t ? [{ type: "setRefined", id: c.id, refinedAt: t.refinedAt ?? null } as Command] : [];
    case "addComment": return [{ type: "removeComment", id: c.id, commentId: c.comment.id } as Command];
    case "moveTaskInLane": { const i = laneOrder.indexOf(c.id); return i < 0 ? [] : [{ type: "moveTaskInLane", id: c.id, toIndex: i } as Command]; }
  }
  return [];
}


const status = (t: any) => ({ todo: "not started", running: "running", paused: "paused", done: "done" })[statusOf(t)];
const projectOf = (doc: any, t: any) => (doc.colors ?? []).find((c: any) => c.id === t.color?.[0])?.label ?? "";
// IN THE PLAN'S ZONE, with the clock. Instants are stored in UTC, so slicing the
// date off one named the next day for anything due after 7pm in Chicago.
const local = (doc: any, iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: zoneOf(doc) }).slice(0, 16);
const brief = (doc: any, t: any) => ({ id: t.id, name: t.label, project: projectOf(doc, t), status: status(t), ...(t.due ? { due: local(doc, t.due) } : {}) });

const embCache = new Map<string, number[]>();
async function embed(texts: string[]) {
  const missing = [...new Set(texts.filter(t => !embCache.has(t)))];
  for (let i = 0; i < missing.length; i += 64) {
    const chunk = missing.slice(i, i + 64);
    const r = await fetch(`${OLLAMA}/api/embed`, { method: "POST", body: JSON.stringify({ model: "nomic-embed-text", input: chunk }) });
    const { embeddings } = await r.json();
    chunk.forEach((t, k) => embCache.set(t, embeddings[k]));
  }
  return texts.map(t => embCache.get(t)!);
}
const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / Math.sqrt(x * y); };

async function run(name: string, a: any, ctx: Ctx, undo: any[]): Promise<unknown> {
  const doc = ctx.getDoc();
  const task = (id: string) => doc.tasks.find((t: any) => t.id === id);
  const write = async (cmds: any[], say: string, taskId?: string) => {
    const laneOrder = doc.tasks.map((t: any) => t.id);
    const back = cmds.flatMap(c => inverse(c, doc, laneOrder)).reverse();
    await ctx.call("commands", { cmds });
    // The page learns of its own write over the socket a moment later; wait for new tasks to land so the
    // next tool call in this turn (link the task just added) can see them.
    const ids = cmds.filter(c => c.type === "addTask").map(c => c.task.id);
    for (let i = 0; i < 30 && !ids.every(id => ctx.getDoc().tasks.some((t: any) => t.id === id)); i++) await new Promise(r => setTimeout(r, 100));
    undo.unshift(...back);
    ctx.onAction(say, taskId);
    return { ok: true };
  };
  switch (name) {
    case "search_tasks": {
      const pool = doc.tasks.filter((t: any) => a.include_done || !t.done);
      const [q, ...labs] = await embed([String(a.query ?? ""), ...pool.map((t: any) => t.label)]);
      return pool.map((t: any, i: number) => [cos(q, labs[i]), t] as const).sort((x: any, y: any) => y[0] - x[0])
        .slice(0, 8).map(([, t]: any) => brief(doc, t));
    }
    case "get_task": {
      const t = task(a.id); if (!t) return { error: "no such id" };
      return { ...brief(doc, t), minutes: t.dur, description: String(t.desc ?? "").slice(0, 1500),
        waits_for: (t.deps ?? []).map((d: string) => ({ id: d, name: task(d)?.label })),
        waited_on_by: doc.tasks.filter((x: any) => x.deps?.includes(t.id)).map((x: any) => ({ id: x.id, name: x.label })),
        signed_off: !!t.refinedAt, comments: (t.comments ?? []).slice(-5).map((c: any) => c.text?.slice(0, 300)) };
    }
    case "plan_overview": {
      const end = (t: any) => String(actualsOf(t).actualEnd)
      if (a.about === "recently_done") return doc.tasks.filter((t: any) => t.done).sort((x: any, y: any) => end(y).localeCompare(end(x))).slice(0, 10).map((t: any) => brief(doc, t));
      if (a.about === "in_progress") return doc.tasks.filter((t: any) => !t.done && t.sessions?.length).map((t: any) => brief(doc, t));
      const rows: any[] = await ctx.call("ready");
      const name = (id: string) => task(id)?.label ?? id;
      if (a.about === "blocked") return rows.filter(r => r.blockedBy?.length).slice(0, 10).map(r => ({ id: r.id, name: name(r.id), waiting_on: r.blockedBy.map(name) }));
      if (a.about === "due") return rows.filter(r => r.due && r.status !== "done").sort((x, y) => x.due.localeCompare(y.due)).slice(0, 10).map(r => ({ id: r.id, name: name(r.id), due: local(doc, r.due) }));
      return rows.filter(r => r.status === "todo" && !r.blockedBy?.length && r.waitingOn !== "deps")
        .sort((x, y) => (x.starts ?? "").localeCompare(y.starts ?? "")).slice(0, 5).map(r => ({ id: r.id, name: name(r.id), starts: r.starts && local(doc, r.starts) }));
    }
    case "add_task": {
      const id = `${String(a.label).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
      const proj = a.project ? (doc.colors ?? []).find((c: any) => c.label.toLowerCase().includes(String(a.project).toLowerCase()) || String(a.project).toLowerCase().includes(c.label.toLowerCase())) : null;
      const deps = (a.waits_for ?? []).filter((d: string) => task(d));
      const cmds: any[] = [{ type: "addTask", task: { id, label: a.label, dur: Math.round(a.minutes ?? 60), lane: doc.lanes?.[0]?.id,
        ...(proj ? { color: [proj.id] } : {}), ...(deps.length ? { deps } : {}), ...(a.description ? { desc: a.description } : {}) } }];
      if (a.due) cmds.push({ type: "setDue", id, due: `${a.due}T17:00:00.000Z` });
      if (a.started) cmds.push({ type: "startTask", id });
      await write(cmds, `added “${a.label}”`, id);
      return { ok: true, id };
    }
    case "update_task": {
      const t = task(a.id); if (!t) return { error: "no such id: search_tasks first" };
      const now = new Date().toISOString(), cmds: any[] = [];
      if (a.label) cmds.push({ type: "renameTask", id: t.id, label: a.label });
      if (a.minutes) cmds.push({ type: "setDuration", id: t.id, dur: Math.round(a.minutes) });
      if (a.description) cmds.push({ type: "setTaskDesc", id: t.id, desc: a.description });
      if ("due" in a) cmds.push({ type: "setDue", id: t.id, due: a.due ? `${a.due}T17:00:00.000Z` : null });
      const st = statusOf(t);
      if (a.status && a.status !== "done" && st === "done") cmds.push({ type: "reopenTask", id: t.id });
      if (a.status === "started" && st !== "running") cmds.push({ type: "startTask", id: t.id });
      if (a.status === "paused" && st === "running") cmds.push({ type: "stopTask", id: t.id });
      if (a.status === "done" && st !== "done") cmds.push({ type: "finishTask", id: t.id });
      if (a.signed_off) cmds.push({ type: "setRefined", id: t.id, refinedAt: now });
      if (!cmds.length) return { error: "nothing to change" };
      await write(cmds, `updated “${a.label ?? t.label}”${a.status ? ` (${a.status})` : ""}`, t.id);
      return { ok: true };
    }
    case "link_tasks": {
      if (!task(a.id) || !task(a.waits_for)) return { error: "no such id: search_tasks first" };
      await write([{ type: "addDep", id: a.id, dep: a.waits_for }], `“${task(a.id).label}” waits for “${task(a.waits_for).label}”`, a.id);
      return { ok: true };
    }
    case "comment_task": {
      if (!task(a.id)) return { error: "no such id: search_tasks first" };
      await write([{ type: "addComment", id: a.id, comment: { id: `c-${Math.random().toString(36).slice(2, 10)}`, text: a.text } }], `commented on “${task(a.id).label}”`, a.id);
      return { ok: true };
    }
    case "delete_task": {
      const t = task(a.id); if (!t) return { error: "no such id: search_tasks first" };
      const waiting = doc.tasks.filter((x: any) => x.deps?.includes(t.id)).length;
      ctx.requestApproval({ title: `Delete “${t.label}”?`, confirm: "Delete", taskId: t.id, done: `deleted “${t.label}”`,
        detail: [a.reason, waiting ? `${waiting} task(s) wait on it and will lose that link` : ""].filter(Boolean).join(" · "),
        cmds: [{ type: "removeTask", id: t.id }] });
      return { pending: true, note: "Shown to Rascal Two as a card. Nothing is deleted until he presses Delete." };
    }
    case "move_task": {
      if (!task(a.id)) return { error: "no such id: search_tasks first" };
      await write([{ type: "moveTaskInLane", id: a.id, toIndex: a.position === "bottom" ? doc.tasks.length : 0 }], `moved “${task(a.id).label}” to the ${a.position}`, a.id);
      return { ok: true };
    }
  }
  return { error: `no tool ${name}` };
}

// Traces go to a local Phoenix only if one answers (tracing.ts); otherwise none of that code even loads.
let tracingModule: Promise<typeof import("./tracing.js") | null> | null = null;
const tracing = () => tracingModule ??= fetch("/phoenix/healthz", { cache: "no-store" })
  .then(r => r.ok ? import("./tracing.js") : null).catch(() => null);

/** One user turn: loop model <-> tools until the model answers in words. Mutates `history`.
 *  Returns the reply text and the batch that undoes every change this turn made. */
export async function turn(history: Msg[], text: string, ctx: Ctx, sessionId?: string) {
  const T = await tracing();
  const agent = T?.start("chat turn", "AGENT", { "input.value": text, "session.id": sessionId, "llm.model_name": MODEL });
  history.push({ role: "user", content: text });
  const undo: any[] = [];
  try {
    for (let step = 0; step < 10; step++) {
      const llm = T?.start(`ollama.chat ${MODEL}`, "LLM", { "llm.model_name": MODEL, "llm.provider": "ollama",
        "session.id": sessionId, ...T.messages("llm.input_messages", history) }, agent);
      const r = await fetch(`${OLLAMA}/api/chat`, { method: "POST", body: JSON.stringify({
        model: MODEL, messages: history, tools: TOOLS, stream: false, think: false, keep_alive: "15m", options: { temperature: 0 } }) });
      if (!r.ok) { const err = new Error(`Ollama ${r.status}: ${(await r.text()).slice(0, 200)}`); if (llm) T!.end(llm, {}, err); throw err; }
      const j = await r.json(), msg = j.message;
      if (llm) T!.end(llm, { ...T!.messages("llm.output_messages", [msg]), "output.value": msg.content,
        "llm.token_count.prompt": j.prompt_eval_count, "llm.token_count.completion": j.eval_count,
        "llm.token_count.total": (j.prompt_eval_count ?? 0) + (j.eval_count ?? 0) });
      history.push(msg);
      if (!msg.tool_calls?.length) {
        if (agent) T!.end(agent, { "output.value": msg.content, "steps": step + 1 });
        return { reply: msg.content as string, undo };
      }
      for (const c of msg.tool_calls) {
        const args = c.function.arguments ?? {};
        const tool = T?.start(c.function.name, "TOOL", { "tool.name": c.function.name, "input.value": args, "tool.parameters": args, "session.id": sessionId }, agent);
        let result: unknown, failed: unknown;
        try { result = await run(c.function.name, args, ctx, undo); }
        catch (e: any) { failed = e; result = { error: String(e.message ?? e) }; }
        if (tool) T!.end(tool, { "output.value": result }, failed ?? ((result as any)?.error ? (result as any).error : undefined));
        history.push({ role: "tool", content: JSON.stringify(result) });
      }
    }
    if (agent) T!.end(agent, { "output.value": "(stopped after 10 steps)" });
    return { reply: "(stopped after 10 steps)", undo };
  } catch (e) {
    if (agent) T!.end(agent, {}, e);
    throw e;
  }
}
