// THE PLAN'S CHAT (agent.ts does the work). Type or dictate (Handy) a request; the local model looks
// things up and changes the plan with tools, and says what it did. Messages accumulate until Clear; there
// are no saved sessions (Rascal Two, 2026-09-27). Undo reverses everything the last reply changed.
import { useEffect, useRef, useState } from "react";
import { turn, systemPrompt, inverse, MODEL, type Msg, type Approval } from "../agent.js";

export type AssistantProps = {
  getDoc: () => any;
  call: (path: string, body?: unknown) => Promise<any>;
  canEdit: () => boolean;
  /** Select a task so the inspector shows it (without taking focus from the chat). */
  openTask: (id: string) => void;
};

type Line = { who: "you" | "agent" | "action" | "error" | "approval"; text: string; taskId?: string;
  approval?: Approval & { state: "pending" | "approved" | "rejected" } };

export function Assistant({ getDoc, call, canEdit, openTask }: AssistantProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<any[]>([]);
  const history = useRef<Msg[]>([]);
  const session = useRef(crypto.randomUUID());       // one Phoenix session per chat, new on Clear
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const toggle = () => setOpen(o => !o);
    window.addEventListener("assistant:toggle", toggle);
    return () => window.removeEventListener("assistant:toggle", toggle);
  }, []);
  useEffect(() => { if (open) box.current?.focus(); }, [open]);
  useEffect(() => { list.current?.scrollTo(0, 1e9); }, [lines, busy]);

  const add = (l: Line) => setLines(ls => [...ls, l]);
  const settle = (i: number, state: "approved" | "rejected") =>
    setLines(ls => ls.map((l, k) => k === i && l.approval ? { ...l, approval: { ...l.approval, state } } : l));

  /** The user's click on an approval card: only here does the change happen. The model hears the outcome
   *  on its next turn, so it never claims a deletion that was refused. */
  async function decide(i: number, a: Approval, yes: boolean) {
    if (!yes) {
      settle(i, "rejected");
      history.current.push({ role: "user", content: `(I pressed Keep: do not do "${a.title}".)` });
      return;
    }
    try {
      const doc = getDoc(), laneOrder = doc.tasks.map((t: any) => t.id);
      const back = a.cmds.flatMap(c => inverse(c, doc, laneOrder)).reverse();
      await call("commands", { cmds: a.cmds });
      settle(i, "approved"); setUndo(back);
      add({ who: "action", text: a.done });
      history.current.push({ role: "user", content: `(I pressed ${a.confirm}: ${a.done}.)` });
    } catch (e: any) { add({ who: "error", text: e.message ?? String(e) }); }
  }

  async function send() {
    const said = text.trim();
    if (!said || busy) return;
    if (!canEdit()) return add({ who: "error", text: "This plan can't be edited right now." });
    setText(""); add({ who: "you", text: said }); setBusy(true);
    if (!history.current.length) history.current.push(systemPrompt(getDoc()));
    try {
      const r = await turn(history.current, said, { getDoc, call, onAction: (t, taskId) => add({ who: "action", text: t, taskId }),
        requestApproval: a => add({ who: "approval", text: a.title, taskId: a.taskId, approval: { ...a, state: "pending" } }) }, session.current);
      setUndo(r.undo);
      add({ who: "agent", text: r.reply || "(done)" });
    } catch (e: any) {
      add({ who: "error", text: `${e.message ?? e} (is Ollama running with ${MODEL}?)` });
    }
    setBusy(false);
  }

  function clear() { history.current = []; session.current = crypto.randomUUID(); setLines([]); setUndo([]); }

  if (!open) return null;
  return (
    <div className="assistant" onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
      <div className="assistant-log" ref={list}>
        {!lines.length && <div className="muted">Ask anything about the plan, or tell it what to change: “what's blocked?”, “add renew passport, due Friday”, “I'm done with the dentist call”.</div>}
        {lines.map((l, i) => l.approval ? <div key={i} className={`assistant-line approval ${l.approval.state}`}>
          <b>{l.text}</b>{l.approval.detail && <div className="muted">{l.approval.detail}</div>}
          {l.approval.state === "pending" ? <div className="assistant-approve">
            <button className="danger" onClick={() => decide(i, l.approval!, true)}>{l.approval.confirm}</button>
            <button onClick={() => decide(i, l.approval!, false)}>Keep</button>
            {l.taskId && <button className="assistant-open" onClick={() => openTask(l.taskId!)}>Open ↗</button>}
          </div> : <div className="muted">{l.approval.state === "approved" ? "done" : "kept"}</div>}
        </div> : <div key={i} className={`assistant-line ${l.who}`}>
          {l.who === "action" ? `✓ ${l.text}` : l.text}
          {l.taskId && <button className="assistant-open" title="Show this task in the inspector" onClick={() => openTask(l.taskId!)}>Open ↗</button>}
        </div>)}
        {busy && <div className="assistant-line muted">thinking…</div>}
      </div>
      <div className="assistant-row">
        <textarea ref={box} rows={1} value={text} placeholder="Message the plan…"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="assistant-send" onClick={send} disabled={!text.trim() || busy}>Send ⏎</button>
      </div>
      <div className="assistant-tools">
        {undo.length > 0 && !busy && <button onClick={async () => { await call("commands", { cmds: undo }); setUndo([]); add({ who: "action", text: "undid the last reply's changes" }); }}>Undo last reply</button>}
        <button onClick={clear} disabled={busy}>Clear</button>
        <span className="muted">{MODEL} · local</span>
      </div>
    </div>
  );
}
