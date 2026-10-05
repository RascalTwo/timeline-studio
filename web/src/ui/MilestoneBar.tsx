// THE MILESTONE ROW — the first region of this page that React draws.
//
// WHY THIS ONE FIRST. It is small, it owns exactly one container (`#msbar`), and
// it carries all three of the workarounds the old render model forces, so porting
// it deletes them rather than merely moving them:
//
//   1. `emit(cmd, keep)` — the milestone name box is an `oninput`, so every
//      keystroke rebuilt the row and blew the caret away. `keep` named a selector
//      to re-focus afterwards. React keeps the same <input> across a render, so
//      the caret never moves and there is nothing to restore.
//   2. `applyFilter()` reached into `#msbar` and toggled `.on` by hand, with a
//      comment saying `milestoneBar()` could not be called from there because it
//      "rebuilds two live <input>s per chip" on every pointer move across the
//      legend. Reconciling touches one className.
//   3. `reorderChip()` did `bar.querySelector(".ms.reord")?.remove()` and then
//      appended a fresh node, because there was no other way to change one chip
//      without rebuilding the row. It is a prop now.
//
// It is PRESENTATION ONLY, and takes no domain type but `Id`. Everything on
// screen here is derived — a milestone's slack, whether it binds the start date,
// what the current filter selects — and all of that derivation stays in `app.ts`
// beside the scheduler wrappers it needs. So this file cannot compute a date, and
// cannot disagree with the chart about one. The view model below is the whole
// contract between the two.
import { useState } from "react";
import type { ReactNode } from "react";
import type { Id } from "../types.js";

/** How a milestone came out: `ok` has slack, `late` misses, `tight` lands exactly
 *  on the day, `empty` has no work assigned to it at all. Drives the colour. */
export type MilestoneTone = "ok" | "late" | "tight" | "empty";

export interface MilestoneChip {
	id: Id;
	label: string;
	/** ISO `YYYY-MM-DD`, straight into `<input type="date">`. */
	date: string;
	tone: MilestoneTone;
	/** "misses by 27 days", "20 days to spare", "no work assigned". */
	verdict: string;
	/** "work ends Dec 14", or "—" when nothing is assigned. */
	ends: string;
	tasks: number;
	/** This is the milestone the plan's start date is pinned to. Only ever true
	 *  for one chip, and only when there is more than one milestone to choose. */
	binding: boolean;
	/** Currently picked in the filter. */
	on: boolean;
}

export interface MilestoneBarProps {
	chips: MilestoneChip[];
	/** "67 tasks · 13.4 weeks" for the whole plan. */
	whole: string;
	/** "42 left · 17.9 days", or "all done". Null where it would only repeat
	 *  `whole` — nothing finished yet — which is the same reason `selected` is
	 *  null on a wide-open filter. */
	wholeLeft: string | null;
	/** The version being compared against, or null when nothing is. */
	compare: string | null;
	/** What the legend + query + chain focus currently select, or null when the
	 *  filter is wide open and the card would be a duplicate of `whole`. */
	selected: { total: string; left: string | null; criteria: string } | null;
	lastSave: { ago: string; note: string | null } | null;
	/** The Order nudge, or null for "nothing to say". `stale` means the plan has
	 *  changed since this answer was computed — on a plan expensive enough to need
	 *  the server, an edit marks the advice out of date rather than silently
	 *  spending another 23 seconds recomputing it. */
	/** `ms` is how long the LAST search took on this machine, which is the only
	 *  honest basis for a progress bar: the work is the same every time, so the
	 *  previous run is a good prediction of this one. Null before the first. */
	/** `unranked` is how many unfinished tasks the ranking has not placed yet — a badge. `past` is how many planned
	 *  stretches are over and unanswered (ADR 0020) — the other badge. */
	order: { headline: string; detail: string; stale: boolean; busy: boolean; ms: number | null; unranked: number; past: number } | null;
	onLabel: (id: Id, value: string) => void;
	onDate: (id: Id, value: string) => void;
	onDelete: (id: Id) => void;
	onPick: (id: Id) => void;
	onAdd: () => void;
	onOpenHistory: () => void;
	onOpenReorder: () => void;
	onRecheckOrder: () => void;
}

/** A summary card. Same `.ms.empty` shell as a milestone chip, deliberately —
 *  they sit on one row and reading them as a series is the point. */
function Card(
	{ accent, title, children }:
	{ accent?: string; title: string; children?: ReactNode },
) {
	return (
		<div className="ms empty" style={{ borderLeftColor: accent ?? "var(--line)", minWidth: 170 }}>
			<div className="nm" style={accent ? { color: accent } : undefined}>{title}</div>
			{children}
		</div>
	);
}

export function MilestoneBar(p: MilestoneBarProps) {
	// A long save note used to grow this row until it pushed the chart off the
	// screen. Clamped to four lines by the stylesheet; clicking the note expands it.
	const [noteOpen, setNoteOpen] = useState(false);
	return (
		<>
			{p.chips.map(m => (
				// THE CARD IS THE BUTTON, AND ITS FIELDS ARE NOT. Clicking a chip
				// filters to that milestone on the same terms the legend chips set;
				// the name box, the date box and × keep their own clicks. That is
				// what the `closest` guard is for, and it is the same branch the
				// legend uses.
				<div
					key={m.id}
					className={`ms ${m.tone}${m.binding ? " binding" : ""}${m.on ? " on" : ""}`}
					data-ms={m.id}
					title="Click to show only this milestone's work · click again to widen"
					onClick={e => {
						if ((e.target as HTMLElement).closest("input, button")) return;
						p.onPick(m.id);
					}}
				>
					<button className="x" data-delms={m.id} title="Delete milestone"
					        onClick={() => p.onDelete(m.id)}>×</button>
					{/* CONTROLLED, and that is the whole point of the port. The value
					    comes from the document, `onChange` sends the command, and
					    `emit` applies it locally before the round trip — so the box
					    shows what the plan says on every keystroke. When `emit`
					    REFUSES (playback, no socket, wrong room) it applies nothing,
					    this re-renders from the unchanged document, and the refused
					    character disappears on its own. That is what `emit`'s `keep`
					    argument was hand-rolling. */}
					<input className="n" data-ms-label={m.id} value={m.label}
					       onChange={e => p.onLabel(m.id, e.target.value)} />
					<input className="d" type="date" data-ms-date={m.id} value={m.date}
					       onChange={e => e.target.value && p.onDate(m.id, e.target.value)} />
					<div className="vd">{m.verdict}</div>
					<div className="dt">
						{m.ends} · {m.tasks} task{m.tasks === 1 ? "" : "s"}
						{m.binding && <> · <b style={{ color: "var(--accent)" }}>sets the start date</b></>}
					</div>
				</div>
			))}
			<button id="addms" onClick={p.onAdd}>+ Milestone</button>
			<Card title="Whole plan">
				<div className="dt">{p.whole}</div>
				{/* BEFORE the compare line, which several things read as the LAST `.dt`
				    in this card. It is also the right reading order: what there is,
				    what is left of it, then what it is being measured against. */}
				{p.wholeLeft && <div className="dt left">{p.wholeLeft}</div>}
				{p.compare && <div className="dt" style={{ opacity: .75 }}>vs {p.compare}</div>}
			</Card>
			{p.selected && (
				<Card accent="var(--accent)" title="Selected">
					<div className="dt">{p.selected.total}</div>
					{p.selected.left && <div className="dt left">{p.selected.left}</div>}
					<div className="dt" style={{ opacity: .75 }}>{p.selected.criteria}</div>
				</Card>
			)}
			{/* `data-order-ms`, NOT `data-ms`. This chip held the search's DURATION
			    under the attribute every other chip uses for a MILESTONE ID, so
			    `#msbar [data-ms]` counted it as a milestone — and the only reason
			    nothing noticed is that the chip used to be absent more often than
			    not. It borrowed that attribute's cursor rule too; `.reord` carries
			    its own now. */}
			{p.order && (
				<div className={`ms reord${p.order.stale ? " stale" : ""}${p.order.busy ? " busy" : ""}`}
				     data-order-ms={p.order.ms ?? ""}
				     title={p.order.stale
				       ? "The plan has changed since this was worked out. Nothing here is wrong about the old order — it is just no longer the order you have."
				       : "Review the moves — nothing is applied until you say so"}
				     onClick={p.onOpenReorder}>
					<div className="nm">Review{p.order.past > 0 && (
						<span className="obadge" data-past={p.order.past}
						      title={`${p.order.past} planned stretch${p.order.past === 1 ? " is" : "es are"} over and not answered yet — Review → Past plans`}> {p.order.past}</span>)}
						{p.order.unranked > 0 && (
						<span className="obadge rk" data-unranked={p.order.unranked}
						      title={`${p.order.unranked} unfinished task${p.order.unranked === 1 ? " is" : "s are"} not ranked yet — Review → Rank`}> {p.order.unranked}</span>)}</div>
					{p.order.busy ? <>
						{/* SIZED TO THE LAST RUN, not to a guess. The search costs the same
						    every time, so how long it took here last is the best estimate
						    of how long it will take here now — and on the first run, when
						    there is nothing to go on, it says so rather than animating a
						    bar to a deadline it invented. */}
						<div className="vd">checking…</div>
						<div className="dt">
							{p.order.ms == null
								? <span style={{ opacity: .7 }}>first time on this device</span>
								: <span className="obar">
										<i style={{ animationDuration: `${p.order.ms}ms` }} />
									</span>}
						</div>
					</> : p.order.stale ? <>
						<div className="vd">out of date</div>
						{/* NOT AUTOMATIC, and that is the point. Working this out costs the
						    server ~23s on a big plan, so it happens when somebody wants it
						    rather than after every drag. */}
						<div className="dt">
							<button onClick={e => { e.stopPropagation(); p.onRecheckOrder(); }}>Check again</button>
						</div>
					</> : <>
						<div className="vd">{p.order.headline}</div>
						<div className="dt">{p.order.detail}</div>
					</>}
				</div>
			)}
			{/* OPPOSITE THE MILESTONES, on the same row. "What was the last change,
			    and when" is the first question on opening a plan you have not seen
			    since Friday, and it was two clicks into History. Pushed right by the
			    stylesheet so it stays at the far end however many milestones there
			    are. */}
			{p.lastSave && (
				<div className="ms lastsave" title="Open History to see every version"
				     onClick={p.onOpenHistory}>
					<div className="nm">Last change · {p.lastSave.ago}</div>
					{/* Clicking the note expands it in place rather than opening History:
					    History shows notes in a one-line field, so it is not where you go
					    to READ a long one. stopPropagation keeps the chip's History click
					    for the rest of the chip. */}
					<div className={noteOpen ? "dt open" : "dt"}
					     title={p.lastSave.note ?? undefined}
					     onClick={e => { e.stopPropagation(); setNoteOpen(v => !v); }}>
						{p.lastSave.note ?? <i>no note</i>}</div>
				</div>
			)}
		</>
	);
}
