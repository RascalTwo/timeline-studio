// THE SLIM PROJECTION: what the server SENDS, as opposed to what it HOLDS.
//
// The server keeps the whole document (`invalid()`, the cycle check and the applier all need it). What
// changes is the first frame on the socket and `GET /api/plan?slim=1`: the free text (`desc`, `comments`)
// is 87% of the bytes and nothing that computes a date reads it, and finished work from before the
// window is two thirds of the tasks and changes no start, end, rank or slack of the open ones. Measured
// on the real plan: 4.2 MB -> 0.6 MB raw. The decision record is `.scratch/lazy-plan-load/README.md`.
//
// SERVER-ONLY SHARED CODE, deliberately not linked from `web/`: the page never builds a projection, it
// receives one. The client half (a document that knows it is partial) is in `commands.ts`, which the
// page already loads. The test harness imports this file to play the server.
import type { Doc, Id, Light, Task } from "./types.js";

/** The two fields that leave the first load. */
export const TEXT_FIELDS = ["desc", "comments"] as const;

/** Finished work stays in the welcome for this long (Q3). Older work is `archived`. */
export const WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

/** The task without its text. A copy: the room's own task is never touched. */
export const withoutText = (t: Task): Task => {
  const out = { ...t };
  for (const k of TEXT_FIELDS) Reflect.deleteProperty(out, k);
  return out;
};

/** When a finished task finished: its last session's stop, as epoch ms. Not-a-number for work not done. */
export const finishedAt = (t: Task): number => {
  if (!t.done) return Number.NaN;
  const stop = t.sessions?.at(-1)?.stop;
  return stop ? Date.parse(stop) : Number.NaN;
};

/** WHICH TASKS THE WELCOME CARRIES, and the instant before which finished work is left out.
 *
 *  Kept: every open task; a finished task that finishes in the future or finished within the window; and
 *  the TRANSITIVE dependencies of everything kept. The closure is not optional: the pruning experiment
 *  that kept only direct dependencies of open tasks answered `blockedBy` wrongly on 11 rows, because a
 *  retained finished task had lost its own dependencies. It runs from every kept task, so a document the
 *  page holds never has a dependency on a task it does not hold.
 *
 *  A plan with milestones keeps every task: a milestone is not met until everything assigned to it AND
 *  everything those wait on is done, `verdict` reads the finished ones' ends, and an unassigned task
 *  belongs to the first milestone — so pruning there would change what the milestone chips say. */
export function keepSet(doc: Doc, now: number): { keep: Set<Id>; before: string } {
  const cut = now - WINDOW_DAYS * DAY_MS;
  const byId = new Map<Id, Task>(doc.tasks.map((t) => [t.id, t]));
  const everything = (doc.milestones?.length ?? 0) > 0;
  const keep = new Set<Id>();
  const todo: Task[] = [];
  const add = (t: Task | undefined) => {
    if (t && !keep.has(t.id)) {
      keep.add(t.id);
      todo.push(t);
    }
  };
  for (const t of doc.tasks) if (!t.done || everything || !(finishedAt(t) < cut)) add(t);
  for (let t = todo.pop(); t; t = todo.pop()) for (const d of t.deps ?? []) add(byId.get(d));
  return { keep, before: new Date(cut).toISOString() };
}

/** The few fields of a task that a count over the whole plan reads (`Light`). */
export const lightOf = (t: Task): Light => ({
  color: t.color ?? [],
  border: t.border,
  fill: t.fill,
  shape: t.shape,
  dur: t.dur,
  deps: t.deps,
});

/** What the welcome says about the tasks it left out. `ids` is every task in document order, `lanes`
 *  the lane of each one left out and `light` the rest of what the page counts with: array position is queue position (ADR 0001), and `moveTaskInLane`'s
 *  `toIndex` counts the finished tasks too, so a page that does not hold them still has to know where they sit. */
export interface Archived {
  count: number;
  before: string;
  ids: Id[];
  lanes: Record<Id, Id>;
  light: Record<Id, Light>;
}

/** The slim document and what it left out. */
export function slimDoc(doc: Doc, now = Date.now()): { doc: Doc; archived: Archived } {
  const { keep, before } = keepSet(doc, now);
  const lanes: Record<Id, Id> = {};
  const light: Record<Id, Light> = {};
  for (const t of doc.tasks)
    if (!keep.has(t.id)) {
      lanes[t.id] = t.lane;
      light[t.id] = lightOf(t);
    }
  return {
    doc: { ...doc, tasks: doc.tasks.filter((t) => keep.has(t.id)).map((t) => withoutText(t)) },
    archived: {
      count: doc.tasks.length - keep.size,
      before,
      ids: doc.tasks.map((t) => t.id),
      lanes,
      light,
    },
  };
}

/** The whole plan with the text left out: `GET /api/plan?slim=1`. Every task stays. */
export const withoutTextDoc = (doc: Doc): Doc => ({ ...doc, tasks: doc.tasks.map(withoutText) });

/** What `GET /api/tasks?ids=` returns for one task: the text, and nothing else. */
export const textOf = (t: Task) => ({ id: t.id, desc: t.desc ?? null, comments: t.comments ?? [] });

/** A request for tasks, on the socket. One of `ids` and `since` selects. */
export interface LoadRequest {
  ref?: string;
  /** These tasks by id. */
  ids?: Id[];
  /** Finished tasks that finished at or after this instant; null is all of them. With `until`, a range. */
  since?: string | null;
  until?: string;
  /** Carry `desc` and `comments`. */
  text?: boolean;
  /** Add the transitive dependencies of what was selected, so the page never holds a task without them. */
  deps?: boolean;
}

/** Cap on the ids of one request, so a hostile frame cannot make the server walk the plan a million times. */
export const LOAD_IDS_MAX = 500;

/** The reply, sent on the same socket so it sits in the stream: every `cmd` frame the client saw before it has
 *  `seq <= seq` (the reply already contains it) and every one after has `seq > seq` (apply it). `text` names
 *  the tasks that carry their text; `gone` the requested ids the plan does not have. */
export interface LoadedFrame {
  type: "loaded";
  ref?: string | undefined;
  seq: number;
  tasks: Task[];
  text: Id[];
  gone: Id[];
}

/** Answer a `LoadRequest` from the live document. Pure: the room supplies `seq`. */
export function loadReply(doc: Doc, req: LoadRequest, seq: number): LoadedFrame {
  const byId = new Map<Id, Task>(doc.tasks.map((t) => [t.id, t]));
  const want: Task[] = [];
  const gone: Id[] = [];
  if (Array.isArray(req.ids)) {
    for (const id of req.ids.slice(0, LOAD_IDS_MAX)) {
      const t = byId.get(id);
      if (t) want.push(t);
      else gone.push(id);
    }
  } else if (req.since !== undefined) {
    const since = req.since === null ? -Infinity : Date.parse(req.since);
    const until = req.until === undefined ? Infinity : Date.parse(req.until);
    want.push(
      ...doc.tasks.filter((t) => t.done && finishedAt(t) >= since && finishedAt(t) < until),
    );
  }
  const sent = new Map<Id, Task>(want.map((t) => [t.id, t]));
  const text = req.text === true ? want.map((t) => t.id) : [];
  const out = want.map((t) => (req.text === true ? t : withoutText(t)));
  if (req.deps === true)
    for (let i = 0; i < want.length; i++)
      for (const d of want[i]!.deps ?? []) {
        const t = byId.get(d);
        if (t && !sent.has(d)) {
          sent.set(d, t);
          want.push(t);
          out.push(withoutText(t));
        }
      }
  return {
    type: "loaded",
    ref: req.ref,
    seq,
    tasks: JSON.parse(JSON.stringify(out)) as Task[],
    text,
    gone,
  };
}
