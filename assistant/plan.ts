// The slice of a plan the brain reasons over: tasks as they stood at one instant.

export type Task = { id: string; label: string; color?: string[]; deps?: string[];
  createdAt?: string; actualStart?: string | null; actualEnd?: string | null; dur?: number }
export type Plan = { tasks: Task[]; colors: { id: string; label: string }[]; lane: string }

/** The plan as it was at `at`: tasks created after it did not exist yet, and a finish or
 *  start recorded after it had not happened yet. (Labels are today's; renames are rare.) */
export function asOf(doc: any, at: string): Plan {
  const t0 = Date.parse(at)
  const before = (s?: string | null) => !!s && Date.parse(s) <= t0
  return {
    lane: doc.lanes?.[0]?.id,
    colors: (doc.colors ?? []).map((c: any) => ({ id: c.id, label: c.label })),
    tasks: doc.tasks
      .filter((t: any) => !t.createdAt || before(t.createdAt))
      // Started at the first session's start; finished, if done, at the last stop (schema v8 stores only sessions).
      .map((t: any) => {
        const ss = t.sessions ?? [], s = ss[0]?.start, e = t.done ? ss[ss.length - 1]?.stop : null
        return { ...t, actualStart: before(s) ? s : null, actualEnd: before(e) ? e : null }
      }),
  }
}

export const isDone = (t: Task) => !!t.actualEnd
