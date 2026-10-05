// THE ORDER PANEL — measured advice about queue order, and it applies nothing on
// its own.
//
// Queue order is a scheduling input that leaves no trace in the document and no
// arrow on the chart, so a plan can be weeks wrong with every duration and every
// dependency correct. This is the only place that says so, which is exactly why it
// must not overstate: every row carries what it costs, and a row whose measurement
// is out of date goes DEAD rather than dim.
import type { Id } from "../types.js";

export interface Suggestion {
	id: Id;
	label: string;
	/** 1-based on screen; the command is 0-based. */
	from: number;
	to: number;
	/** The task this one would sit after, or null for "first in the queue". */
	after: string | null;
	/** Buys one date and costs another. */
	worsens: boolean;
	gain: string;
	/** WHICH of the score's terms this number is. The search has one per question
	 *  the plan can be asked — finish date, a missed deadline, breathing room
	 *  before one, each milestone — and "+0.72d" means something different for
	 *  every one of them. */
	bought: string;
}

export interface ReorderPanelProps {
	/** Silence is the normal state and it has to look like it. */
	empty: boolean;
	/** Set between applying a move and the recomputed answer landing. */
	staleAfter: string | null;
	/** The plan changed under this answer and it has NOT been recomputed, because
	 *  on a plan this size that costs the server ~23 seconds and nobody asked. */
	outOfDate: boolean;
	onRecheck: () => void;
	/** Lane order is a search over lanes rather than tasks, so it comes free. */
	laneSort: { was: number; backward: number } | null;
	suggestions: Suggestion[];
	/** Queues too long to search, named rather than dropped. */
	skipped: { lane: string; tasks: number }[];
	/** Number of moves Apply all has made so far, or null when it is not running.
	 *  A count rather than a boolean because the only honest thing to show while
	 *  a loop edits a shared document is how much it has already done. */
	applying: number | null;
	onApplyAll: () => void;
	onStopApplyAll: () => void;
	onSortLanes: () => void;
	onApply: (i: number) => void;
}

export function ReorderPanel(p: ReorderPanelProps) {
	if (p.empty) return (
		<div className="hint">Nothing to move — every queue is already in the order
			that finishes soonest and misses the fewest deadlines, agrees with your
			ranking wherever the dates allow, and no team sits above one it waits on.</div>
	);
	// WHY THE BUTTONS GO OFF AND NOT JUST DIM. A stale suggestion is still a VALID
	// command — it would apply, and it would move a row. It just would not do what
	// its own label promises, which is the one failure mode a panel of measured
	// advice cannot afford.
	// EVERY OTHER BUTTON GOES OFF WHILE THE LOOP RUNS, not just the stale ones.
	// Apply all is already moving rows; a second command aimed at a list that is
	// mid-recompute is the stale-advice bug this panel exists to avoid.
	const dead = p.staleAfter !== null || p.outOfDate || p.applying !== null;
	const rowStyle = dead ? { opacity: .45 } : undefined;
	return (
		<>
			{/* RUN TO CONVERGENCE. Applying one move at a time is correct and it is
			    also ten clicks with a two-second wait between each — the correctness
			    came from re-measuring after every move, not from a human pressing
			    the button, so the loop keeps the first and automates the second.
			    The stop is not a nicety: this edits a shared plan, so there has to
			    be a way to say "that is enough" that does not involve closing the
			    tab. */}
			<div className="rsug">
				<div>
					<div className="what">{p.applying === null
						? "Apply every suggestion, re-measuring after each one"
						: `Applying… ${p.applying} move${p.applying === 1 ? "" : "s"} so far`}</div>
					<div className="why">{p.applying === null
						? "stops when nothing is left to improve — each move is scored against the order it lands on, never against this list"
						: "each move is being re-measured before the next one is chosen"}</div>
				</div>
				<div className="gain" />
				{p.applying === null
					? <button data-applyall disabled={p.staleAfter !== null || p.outOfDate || !p.suggestions.length}
					          onClick={p.onApplyAll}>Apply all</button>
					: <button data-stopapplyall onClick={p.onStopApplyAll}>Stop</button>}
			</div>
			{p.staleAfter !== null && (
				<div className="hint" style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 8 }}>
					Moved <b>{p.staleAfter}</b>. Recomputing the rest — the numbers below were
					measured against the old order.
				</div>
			)}
			{p.outOfDate && p.staleAfter === null && (
				<div className="hint" style={{ borderLeft: "3px solid var(--accent)", paddingLeft: 8 }}>
					The plan has changed since this was worked out, so every number below is
					measured against an order you no longer have. Nothing here is wrong — it is
					just answering an older question.{" "}
					<button onClick={p.onRecheck}>Check again</button>
				</div>
			)}
			{p.laneSort && (
				<div className="rsug" style={rowStyle}>
					<div>
						<div className="what">Sort the teams by dependencies</div>
						<div className="why">a team above the teams that wait on it, as far as the arrows allow</div>
					</div>
					<div className="gain">{p.laneSort.was} → {p.laneSort.backward}</div>
					<button data-sortlanes disabled={dead} onClick={p.onSortLanes}>Sort teams</button>
				</div>
			)}
			{p.suggestions.map((sg, i) => (
				<div key={sg.id + ":" + i} className="rsug" style={rowStyle}>
					<div>
						<div className="what">
							Move <b>{sg.label}</b> to position {sg.to + 1} in its team
							{sg.after ? <>, after <b>{sg.after}</b></> : " — first in the queue"}
						</div>
						<div className="why">{sg.worsens
							? `${sg.bought} — but it costs another date; read both before taking it`
							: `${sg.bought} · from position ${sg.from + 1}`}</div>
					</div>
					<div className={`gain${sg.worsens ? " trade" : ""}`}>{sg.gain}</div>
					<button data-apply={i} disabled={dead} onClick={() => p.onApply(i)}>Apply</button>
				</div>
			))}
			{p.skipped.length > 0 && (
				<div className="hint" style={{ marginTop: 10 }}>
					Not searched: {p.skipped.map((k, i) => (
						<span key={k.lane}>{i ? ", " : ""}<b>{k.lane}</b> ({k.tasks} tasks)</span>
					))}.
					The search is quadratic and a queue that long is a different problem — said out loud
					rather than dropped, so this panel cannot read as "nothing to improve".
				</div>
			)}
		</>
	);
}
