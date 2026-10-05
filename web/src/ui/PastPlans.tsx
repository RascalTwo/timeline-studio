// PAST PLANS — a planned stretch that is over, on a task that is not finished, asks what happened (ADR 0020).
//
// The clock never turns a plan into a session (ADR 0017): only a person can say it happened. This is where they say it,
// one stretch at a time, oldest first, in two keys: did it happen, then what that means for the task. The same two
// steps answer an "unconfirmed" row in the Inspector, as buttons. Presentation only: `app.ts` builds the list and turns
// an answer into commands. There is no undo, on purpose — a wrong answer is fixed the way any edit is.
import { useEffect, useState } from "react";
import type { Id } from "../types.js";

export interface PastPlan {
	id: Id;
	/** Which of the task's planned stretches. */
	index: number;
	label: string;
	/** "Oct 3 1pm – 2pm", for reading. */
	when: string;
	/** The stretch in the plan zone's `datetime-local` form, so E opens on it. */
	start: string;
	stop: string;
	/** A synced calendar meeting (its `ref` starts `gcal:`). Enter means finished / delete for a meeting, carries on /
	 *  keep for your own work: a meeting that happened is over, and a confirmed-but-open one would queue as paused. */
	meeting: boolean;
}

/** It happened: `finished`, or it `carries-on`. It did not: `delete` the task, or `keep` it without the stretch.
 *  `times` comes only with a happened answer, and only when E corrected them. */
export type PastAnswer = "finished" | "carries-on" | "delete" | "keep";
export type OnPastAnswer = (p: PastPlan, a: PastAnswer, times?: { start: string; stop: string }) => void;

type Step = "ask" | "happened" | "didnt" | "edit";

/** The two-step answer to one stretch. `keys` binds → ← E Enter Esc on the document (the Past plans tab); without it, buttons only. */
export function PastAnswerBox({ plan, onAnswer, keys }: { plan: PastPlan; onAnswer: OnPastAnswer; keys: boolean }) {
	const [step, setStep] = useState<Step>("ask");
	const [times, setTimes] = useState<{ start: string; stop: string } | undefined>();
	const [draft, setDraft] = useState({ start: plan.start, stop: plan.stop });
	// A different stretch starts over.
	useEffect(() => { setStep("ask"); setTimes(undefined); setDraft({ start: plan.start, stop: plan.stop }); },
		[plan.id, plan.index, plan.start, plan.stop]);
	const answer = (a: PastAnswer) => onAnswer(plan, a, a === "finished" || a === "carries-on" ? times : undefined);
	const save = () => { if (draft.start && draft.stop && draft.stop > draft.start) { setTimes(draft); setStep("happened"); } };
	const good: PastAnswer = step === "happened" ? "finished" : "keep";
	const bad: PastAnswer = step === "happened" ? "carries-on" : "delete";
	const deflt: PastAnswer = step === "happened" ? (plan.meeting ? "finished" : "carries-on") : (plan.meeting ? "delete" : "keep");

	useEffect(() => {
		if (!keys) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const inField = e.target instanceof Element && !!e.target.closest("input, textarea, select");
			const take = () => { e.preventDefault(); e.stopPropagation(); };
			if (step === "edit") {
				if (e.key === "Escape") { take(); setStep("ask"); }
				else if (e.key === "Enter") { take(); save(); }
				return;
			}
			if (inField) return;
			if (step === "ask") {
				if (e.key === "ArrowRight") { take(); setStep("happened"); }
				else if (e.key === "ArrowLeft") { take(); setStep("didnt"); }
				else if (e.key === "e" || e.key === "E") { take(); setStep("edit"); }
				return;
			}
			// Esc backs out of the second step instead of closing the panel.
			if (e.key === "Escape") { take(); setStep(times ? "edit" : "ask"); }
			else if (e.key === "ArrowRight") { take(); answer(good); }
			else if (e.key === "ArrowLeft") { take(); answer(bad); }
			else if (e.key === "Enter") { take(); answer(deflt); }
		};
		// The document, not the window: the page's own Escape (close the panel) listens on the window, after this.
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	const btn = (a: PastAnswer, text: string, key: string) => (
		<button data-answer={a} className={a === deflt ? "default" : undefined} onClick={() => answer(a)}
		        title={a === deflt ? `${key}, or Enter` : key}>{text}</button>
	);
	return (
		<div className="past-answer" data-step={step}>
			{step === "ask" && <>
				{/* Symbols alone in the Inspector, where the row is one cell wide; the words are in the title. */}
				<button data-step-to="didnt" onClick={() => setStep("didnt")} title="It didn't happen (←)">✗{keys && " didn't happen"}</button>
				<button data-step-to="happened" onClick={() => setStep("happened")} title="It happened (→)">✓{keys && " happened"}</button>
				<button data-step-to="edit" onClick={() => setStep("edit")} title="It happened at other times (E)">✎{keys && " times"}</button>
			</>}
			{step === "edit" && <>
				<input type="datetime-local" data-edit="start" value={draft.start} onChange={e => setDraft({ ...draft, start: e.target.value })} />
				<span> – </span>
				<input type="datetime-local" data-edit="stop" value={draft.stop} min={draft.start || undefined}
				       onChange={e => setDraft({ ...draft, stop: e.target.value })} />
				<button data-edit="save" onClick={save} title="Enter">save</button>
				<button onClick={() => setStep("ask")} title="Esc">back</button>
			</>}
			{step === "happened" && <>
				<span className="q">Finished?</span>
				{btn("carries-on", "carries on", "←")}
				{btn("finished", "finished", "→")}
				<button onClick={() => setStep(times ? "edit" : "ask")} title="Esc">back</button>
			</>}
			{step === "didnt" && <>
				<span className="q">The task?</span>
				{btn("delete", "delete it", "←")}
				{btn("keep", "keep it", "→")}
				<button onClick={() => setStep("ask")} title="Esc">back</button>
			</>}
		</div>
	);
}

/** The Past plans tab: the oldest stretch to answer, and how many wait behind it. The keys are bound only while the tab
 *  is `active` (on screen), or the arrows would answer a stretch nobody can see. */
export function PastPlans({ plans, onAnswer, active }: { plans: PastPlan[]; onAnswer: OnPastAnswer; active: boolean }) {
	const p = plans[0];
	if (!p) return <div className="hint" id="past-none">Nothing to review: every plan that is over has an answer.</div>;
	return (
		<div id="past-one">
			<div className="hint" style={{ margin: "0 0 8px" }}>Did it happen? <b>→</b> yes, <b>←</b> no, <b>E</b> to correct
				the times first. Then <b>→</b> / <b>←</b> again, or <b>Enter</b> for the highlighted answer. <b>Esc</b> goes back.
				Nothing is undone, and the clock never answers for you.</div>
			<div className="past-task">
				<b>{p.label || p.id}</b> <span className="past-when">{p.when}</span>
				<span className="past-kind">{p.meeting ? "meeting" : "your work"}</span>
			</div>
			<PastAnswerBox plan={p} onAnswer={onAnswer} keys={active} />
			{plans.length > 1 && <div className="hint" id="past-more">{plans.length - 1} more after this</div>}
		</div>
	);
}
