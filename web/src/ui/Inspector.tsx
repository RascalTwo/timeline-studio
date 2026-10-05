// THE INSPECTOR — the page's main editing surface, and the second region React
// draws.
//
// It replaces one 200-line `innerHTML` template plus 30 handler assignments made
// by re-querying children by id afterwards. That idiom is why the panel had to be
// rebuilt from scratch on every keystroke, and the rebuild is what the following
// pieces of machinery existed to survive:
//
//   `emit(cmd, keep)`      — a selector threaded through the COMMAND layer so the
//                            caret could be put back after the rebuild.
//   `renderKeepFocus()`    — the putting back.
//   `#lab`'s blur dance    — a `setTimeout` + `document.activeElement` check,
//                            because the rebuild removed the focused field and
//                            that fires `blur`, so every keystroke looked like
//                            leaving the field and opened the mentions dialog on
//                            a half-typed word.
//   `renameBefore`'s guard — the same rebuild firing `focus` again mid-word.
//
// None of it is needed once the field survives the render. See ADR 0004.
//
// PRESENTATION ONLY. Everything here is a string or a boolean somebody else
// computed: slack, pinning, variance, the estimate comparison, whether a channel
// has enough values to be worth a control. `app.ts` builds the view model beside
// the scheduler wrappers it needs, so this file cannot compute a date and cannot
// disagree with the chart about one.
//
// TWO KINDS OF FIELD, and the difference is not cosmetic:
//   - `#lab` and `#desc` emit on EVERY KEYSTROKE, because watching the bar rename
//     itself as you type is half of what they are for. Controlled from the
//     document; `renameTask` is last-write-wins so a burst collapses.
//   - `#dur`, `#ref` and `#url` commit on blur or Enter. `<CommitField>` is that,
//     and it exists because React's `onChange` is the DOM `input` event, NOT
//     `change` — wiring these to it would emit a command per character, which for
//     `#url` means a refusal at "h", at "ht", at "htt".
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Id } from "../types.js";
import { CommitField } from "./fields.js";
import { PastAnswerBox, type PastPlan, type OnPastAnswer } from "./PastPlans.js";

/** A pointer to a row, or a bare fact. `id` present means it is clickable and
 *  hovering it lights that bar up on the chart. */
export interface Chip {
	id?: Id;
	label: string;
	/** The `<i>` suffix — "pinning", "+3 days", "until Oct 14". */
	tag?: string;
	ghost?: boolean;
	pin?: boolean;
	title?: string;
	/** Renders the × that removes this dependency. Direct deps only. */
	removable?: boolean;
	/** React key, since the same task id can appear in two rows. */
	k?: string;
}

export interface Option { id: Id; label: string }

export interface InspectorTask {
	id: Id;
	label: string;
	desc: string;
	ref: string;
	refPlaceholder: string;
	url: string;
	/** The task resolves to a link, so the ↗ button is lit. */
	hasLink: boolean;
	linkTitle: string;
	/** This browser has a link base for this plan, so a reference becomes a URL. */
	refBaseSet: boolean;
	refTestUrl: string | null;
	/** Already formatted — "3", "2h", "45m". The document stores whole minutes
	 *  (v7) and the page reads days; `app.ts` owns both directions of that so this
	 *  file cannot invent a unit. */
	dur: string;
	lane: Id; lanes: Option[] | null;
	/** null when the channel has fewer than two values — one value is not a
	 *  choice, and the panel is pinned over the chart it describes. */
	colors: { id: Id; label: string; color: string; on: boolean }[] | null;
	colorSummary: string;
	border: Id; borders: Option[] | null;
	fill: Id;   fills: Option[] | null;
	shape: Id;  shapes: Option[] | null;
	ms: Id;     milestones: Option[] | null;
	notBefore: string;
	noQueue: boolean;
	/** The repeat rule this task carries, or null. */
	recur: { n: number; unit: string; ahead: number } | null;
	/** Planned stretches (what is promised; `sessions` is what happened), in the plan zone's `datetime-local` form.
	 *  `unconfirmed`: it is over and nobody has said whether it happened — the Past plans entry to answer it with (ADR 0020). */
	planned: { start: string; stop: string; unconfirmed: PastPlan | null }[];
	/** When this task must FINISH by, `YYYY-MM-DDTHH:MM` in the plan zone, or empty. The opposite
	 *  direction from `notBefore`, and unrelated to the milestone below: a
	 *  milestone dates an OUTCOME several tasks feed. */
	due: string;
	/** Slack against `due` — "3 days to spare", "misses by 2" — computed in
	 *  `app.ts` beside the scheduler, like every other date on this panel. */
	dueSlack: { text: string; tone: "muted" | "danger" | "good" } | null;
	descHtml: string;
	/** Oldest first. `html` is rendered Markdown (escaped before any tag is
	 *  written, like `descHtml`); `when`/`edited` are already formatted. */
	comments: { id: Id; by: string; when: string; edited: string | null; html: string; text: string }[];
	swatch: { cls: string; style: any; coreCls: string | null; color: string;
	          bands: { cls: string; left: string; right: string; color: string }[] };
	/** Finished (`finishTask`); it ended at the last session's stop. */
	done: boolean;
	/** Work sessions in the plan zone's `datetime-local` form; `stop` is "" while one runs. */
	sessions: { start: string; stop: string }[];
	/** "1.5 hrs of 2 hrs": worked so far (wall clock) against the estimate. Empty with no sessions. */
	worked: string;
	refinedAt: string;
	/** "added 3 days ago · edited 4 min ago", already phrased. Empty for a task
	 *  that predates the fields. */
	touched: string;
	/** `max` for a sign-off — it cannot be in the future. */
	todayISO: string;
	/** The plan's zone ("America/Chicago"), named on each `now` button's hover. */
	zone: string;
	chainOn: boolean;
	/** Date mode: the queue arrows have no meaning, and say so on hover. */
	queueDisabled: boolean;
	queueTitle: (live: string) => string;
	startsText: string;
	endsText: string;
	est: { text: string; tone: "muted" | "danger" | "good" } | null;
	variance: { text: string; title: string } | null;
	labels: Record<"lanes" | "colors" | "borders" | "fills" | "shapes", string>;
	deps: Chip[];
	heldBy: Chip[];
	heldLabel: string;
	trans: Chip[];
	blocks: Chip[];
	noDepsHint: string;
	depColors: { direct: string; trans: string; down: string };
	/** Where this sits in the plan's "which should happen first?" ranking — "3 of 17",
	 *  "not ranked yet" — or empty for finished work, which leaves the ranking. */
	rank: string;
}

export interface InspectorProps {
	/** `null` renders nothing — the panel is pinned over the chart, so
	 *  empty-but-present would be stealing screen from the thing it describes. */
	task: InspectorTask | null;
	/** Set while picking the far end of a dependency. */
	linkingFrom: string | null;
	/** Which end of the dependency the armed task is: `blocks` means the next
	 *  click is made to wait for it, `waits` means the armed task waits for
	 *  whatever is clicked. Named after the two dependency rows below, because
	 *  those are the rows each direction fills. */
	linkingDir: "blocks" | "waits";
	/** 0 folded to one row, 1 the strip, 2 the full task. One control cycling three
	 *  sizes, the same shape the lane fold already uses. */
	size: number;
	onFold: () => void;
	onName: (v: string) => void;
	onNameFocus: () => void;
	onNameSettled: () => void;
	onDesc: (v: string) => void;
	onAddComment: (text: string) => void;
	onEditComment: (id: Id, text: string) => void;
	onRemoveComment: (id: Id) => void;
	onDur: (v: string) => void;
	onLane: (v: Id) => void;
	onColors: (ids: Id[]) => void;
	onChannel: (ch: "border" | "fill" | "shape", v: Id) => void;
	onMilestone: (v: Id) => void;
	/** THE CURRENT TIME, ASKED FOR AT CLICK TIME. A component may not compute a
	 *  date, and `task.todayISO` is a snapshot taken when the panel last
	 *  rendered — a panel left open for an hour would stamp the hour it opened. */
	nowISO: () => string;
	onNotBefore: (iso: string) => void;
	onNoQueue: (v: boolean) => void;
	onRecur: (r: { n: number; unit: string; ahead: number } | null) => void;
	onPlanAdd: () => void;
	/** Edit ONE time of ONE planned stretch. */
	onPlanned: (i: number, which: "start" | "stop", value: string) => void;
	onPlannedRemove: (i: number) => void;
	/** That stretch happened: it becomes a session. */
	onPlannedDone: (i: number) => void;
	/** An unconfirmed stretch answered, the same two steps as Review → Past plans. */
	onPastAnswer: OnPastAnswer;
	onDue: (iso: string) => void;
	onRef: (v: string) => void;
	onUrl: (v: string) => void;
	onStartTask: () => void;
	onStopTask: () => void;
	onFinishTask: () => void;
	onReopenTask: () => void;
	/** Edit ONE time of ONE session: the way to put a forgotten stop back. Everything else is left as stored. */
	onSession: (i: number, which: "start" | "stop", value: string) => void;
	onRemoveSession: (i: number) => void;
	onRefined: (iso: string) => void;
	onChain: () => void;
	onDup: () => void;
	onMove: (dir: -1 | 1) => void;
	onDelete: () => void;
	onDismiss: () => void;
	onStartLink: () => void;
	onStartLinkWaits: () => void;
	onCancelLink: () => void;
	onGo: (id: Id) => void;
	onRemoveDep: (id: Id) => void;
	onChipHover: (id: Id, on: boolean) => void;
	/** Measure the panel and reserve its height under the chart. */
	onPainted: () => void;
}

/** Places a `position:fixed` popover above its button, clamped to the window.
 *  Measured after layout and after `hidden` is cleared, or the width reads zero. */
function usePopover(open: boolean) {
	const btn = useRef<HTMLButtonElement>(null);
	const pop = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const p = pop.current, b = btn.current;
		if (!open || !p || !b) return;
		const r = b.getBoundingClientRect();
		// The button's own left edge is the right answer until the button is near
		// the right of the screen — and the link popover's button sits in the
		// inspector head, which is exactly there. Unclamped, a 340px box loses its
		// last 50px off the edge, with no scrollbar to get it back.
		p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + "px";
		p.style.bottom = (window.innerHeight - r.top + 7) + "px";
	});
	return { btn, pop };
}

const chipKey = (c: Chip, i: number) => c.k ?? c.id ?? `${i}:${c.label}`;

function Chips(
	{ list, onGo, onRemoveDep, onChipHover }:
	Pick<InspectorProps, "onGo" | "onRemoveDep" | "onChipHover"> & { list: Chip[] },
) {
	return <>{list.map((c, i) => (
		<span key={chipKey(c, i)}
		      className={`chip${c.ghost ? " ghost" : ""}${c.pin ? " pin" : ""}`}
		      data-go={c.id} title={c.title}
		      onPointerEnter={c.id ? () => onChipHover(c.id!, true) : undefined}
		      onPointerLeave={c.id ? () => onChipHover(c.id!, false) : undefined}
		      onClick={c.id ? e => {
		        // The × is a child of the chip and means "remove", not "go".
		        if ((e.target as HTMLElement).closest("[data-rm]")) return;
		        onChipHover(c.id!, false); onGo(c.id!);
		      } : undefined}>
			{c.label}
			{c.tag && <i>{c.tag}</i>}
			{c.removable && c.id && (
				<button data-rm={c.id} title="remove"
				        onClick={e => { e.stopPropagation(); onRemoveDep(c.id!); }}>×</button>
			)}
		</span>
	))}</>;
}

export function Inspector(p: InspectorProps) {
	const [colrOpen, setColrOpen] = useState(false);
	const [urlOpen, setUrlOpen] = useState(false);
	const [every, setEvery] = useState({ n: 1, unit: "week" });   // the not-yet-saved rule
	// RENDERED BY DEFAULT, EDITED ON PURPOSE. Markdown forces the split — you
	// cannot render and edit one string in one control — and the default belongs
	// to the common case, which is reading. 119 descriptions on the real plan,
	// written once each.
	//
	// Not Write/Preview tabs: a tab strip is permanent chrome on a panel already
	// short of vertical room, and it spends that room on the rarer mode. GitHub
	// uses tabs because you are COMPOSING there; here you are mostly reading.
	const [editing, setEditing] = useState(false);
	const desc = useRef<HTMLTextAreaElement>(null);
	const colr = usePopover(colrOpen);
	const urlp = usePopover(urlOpen);
	const url = useRef<HTMLInputElement>(null);
	// Opening the link popover puts the caret in the URL field and selects what is
	// there — it is opened to REPLACE a link far more often than to read one.
	useEffect(() => { if (urlOpen) { url.current?.focus(); url.current?.select(); } }, [urlOpen]);
	// A DIFFERENT TASK IS A DIFFERENT DESCRIPTION. Without this, clicking from a
	// task you were editing to the next one would open that one in edit mode too.
	useEffect(() => { setEditing(false); }, [p.task?.id]);
	// AND A DIFFERENT TASK OPENS AT THE TOP. The panel is the scroller (`#insp`, overflow-y), React reuses
	// it between selections, and a scrolled-down panel stayed scrolled down for the next task.
	useEffect(() => { document.getElementById("insp")?.scrollTo(0, 0); }, [p.task?.id]);
	// Caret at the end rather than the start: you clicked an existing description
	// to add to it far more often than to retype it.
	useEffect(() => {
		if (!editing) return;
		const el = desc.current; if (!el) return;
		el.focus(); el.setSelectionRange(el.value.length, el.value.length);
	}, [editing]);
	// LEAVING IS AN OUTSIDE CLICK, NOT A BLUR — and that is not a preference.
	// Typing calls `onDesc`, which emits a command, which re-renders the panel and
	// REPLACES this textarea's DOM node; a node that has been swapped out never
	// fires blur, so the mode would stick on forever. Measured: focus moved from
	// the textarea to another field and neither `blur` nor `focusout` arrived.
	// `renderKeepFocus` exists to paper over the same rebuild for the caret.
	//
	// A document-level pointerdown is how every popover in this file already
	// decides it has been dismissed, so this is the established answer here.
	useEffect(() => {
		if (!editing) return;
		const away = (e: PointerEvent) => {
			const el = desc.current, tgt = e.target as Node | null;
			if (el && tgt && !el.contains(tgt)) setEditing(false);
		};
		document.addEventListener("pointerdown", away, true);
		return () => document.removeEventListener("pointerdown", away, true);
	}, [editing]);
	const t = p.task;

	// The panel's height depends on how many dependency chips this task has, so
	// the reservation under the chart is re-measured after every paint.
	useEffect(() => { p.onPainted(); });
	// A different task, or none: any popover open over the old one is stale.
	useEffect(() => { setColrOpen(false); setUrlOpen(false); }, [t?.id, p.linkingFrom]);
	// THE PANEL SCROLLS AND A `position:fixed` POPUP DOES NOT SCROLL WITH IT. Rather
	// than re-measure on every scroll frame, close it — reopening is one click and
	// always lands in the right place. Reaching for the container by id is honest
	// here: `#insp` is the element this component is mounted into, and the listener
	// belongs with the popovers rather than with whoever mounted them.
	useEffect(() => {
		const box = document.getElementById("insp");
		if (!box) return;
		const close = () => setColrOpen(false);
		box.addEventListener("scroll", close);
		return () => box.removeEventListener("scroll", close);
	}, []);

	if (p.linkingFrom !== null) {
		return (
			<div className="linkmsg">
				{/* THE SENTENCE SAYS WHICH CLICK IS WANTED, not which mode is on. It
				    read "Linking from X — click the task that must wait for it",
				    which was fine while there was one direction and is a trap now:
				    the two modes differ only in who waits, so that is the clause
				    that has to change. */}
				{/* THE NAME GOES LAST IN BOTH, which is not style: task labels here run
				    to sixty characters, and "Click the task <sixty characters> must wait
				    for." leaves the verb stranded so far from its subject that the
				    sentence has to be re-read. Both directions end on the name, and the
				    clause before it carries the whole difference. */}
				<span>{p.linkingDir === "blocks"
					? <>Click the task that must wait for <b>{p.linkingFrom}</b>.</>
					: <>Click the task that must be done before <b>{p.linkingFrom}</b>.</>}</span>
				{/* A MODE NEEDS A VISIBLE WAY OUT. "Esc to cancel" is a keybind in prose,
				    which is the same discoverability problem as a keybind with no prose
				    — you have to already be reading to learn it. Escape still works. */}
				<button id="linkcancel" onClick={p.onCancelLink}>Cancel</button>
			</div>
		);
	}
	if (!t) return null;

	// EVERY FIELD IS THE SAME TWO CELLS: a key and its controls. Before this each
	// one carried its own inline fontSize/colour and a marginLeft:6, inside a
	// flex-wrap toolbar — so nothing shared a column, and a label sat on whatever
	// baseline its own control happened to give it. One shape means the rail can
	// become a real grid with one rule instead of twelve.
	const row = (key: string, title: string | undefined, ...kids: any[]) => (
		<label className="frow" title={title}>
			<span className="fk">{key}</span>
			<span className="fv">{kids}</span>
		</label>
	);
	// THE SHORTCUT THE NATIVE PICKER DOES NOT HAVE. Chrome's own datetime-local
	// popup offers Clear and Today and cannot be added to, so "now" has to be our
	// own control — and reporting that work started or finished is the commonest
	// date edit there is, always means this moment, and was two fields' worth of
	// typing. It goes through the SAME handler as a typed date, so the refusals
	// (no future starts, no finishing before starting) are the ones already there.
	// EVERY TIME HERE IS THE PLAN ZONE'S WALL CLOCK, and says so on hover. It was a
	// "CDT" tag beside every date row, which cost each row a column and pushed the
	// × onto a line of its own in the full-size rail.
	const nowBtn = (id: string, set: (iso: string) => void, title: string) =>
		<button key="n" id={id} className="fnow"
		        title={`${title} — times on this plan are ${t.zone}`}
		        onClick={() => set(p.nowISO())}>now</button>;
	// THE × KEEPS ITS SLOT WHEN THERE IS NOTHING TO CLEAR. Appearing and vanishing,
	// it slid every field after it sideways in the strip as dates were set.
	const clear = (id: string, has: string, title: string, fn: () => void) => has
		? <button key="x" id={id} className="fclear" title={title} onClick={fn}>×</button>
		: <span key="x" className="fclear" aria-hidden="true" />;
	const sel = (id: string, label: string, list: Option[] | null, value: Id,
	             onPick: (v: Id) => void) => list && row(label, undefined,
		<select key="s" id={id} value={value} onChange={e => onPick(e.target.value)}>
			{list.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
		</select>
	);

	return (
		<>
			{/* THREE SIZES, ONE BUTTON. Folded is a title bar, the strip is the
			    working default, full gives the description a column of its own. The
			    glyphs are the lane fold's own family so the two cycles read alike. */}
			<button id="inspfold" className="ifold" onClick={p.onFold}
			        title={["Open the fields", "Expand to the full task",
			                "Fold this panel down to one row"][p.size]}>
				{["▾", "▴", "▪"][p.size]}
			</button>
			<div className="toolbar ihead">
				<input type="text" id="lab" value={t.label} placeholder="task name"
				       style={{ flex: 1, minWidth: 220 }}
				       onChange={e => p.onName(e.target.value)}
				       onFocus={p.onNameFocus}
				       onBlur={p.onNameSettled}
				       onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
				{/* Present at all three sizes: at the smallest, the name and this square
				    are the whole answer to "which task is this". */}
				<span className="tswatch" title="How this task is drawn on the chart">
					<span className={t.swatch.cls} style={{ ...t.swatch.style,
					      ...(t.swatch.coreCls ? {} : { backgroundColor: t.swatch.color }) }}>
						{t.swatch.coreCls
							? <span className={t.swatch.coreCls} style={{ backgroundColor: t.swatch.color }}>
								{t.swatch.bands.map((n, i) => <span key={i} className={n.cls}
									style={{ left: n.left, right: n.right, backgroundColor: n.color }} />)}
							  </span>
							: t.swatch.bands.map((n, i) => <span key={i} className={n.cls}
								style={{ left: n.left, right: n.right, backgroundColor: n.color }} />)}
					</span>
				</span>
				<button id="eye" className={t.chainOn ? "on" : ""} onClick={p.onChain}
				        title="Show only this task's chain — what it waits on, what those wait on, and everything it unblocks">👁</button>
				{/* A POPOVER, NOT A THIRD TEXT BOX. The head already spends its width
				    on the two strings you retype constantly; a URL is set once and
				    then only ever followed, and it is long. Lit when the task has
				    one, so the head answers "does this link anywhere" unopened. */}
				<span className="popwrap">
					<button id="urlbtn" ref={urlp.btn} className={t.hasLink ? "on" : ""} title={t.linkTitle}
					        onClick={e => { e.stopPropagation(); setUrlOpen(o => !o); }}>{"↗"}</button>
					<div id="urlpop" ref={urlp.pop} hidden={!urlOpen}>
						<label className="lbl">Reference
							<CommitField type="text" id="ref" value={t.ref} commit={p.onRef}
							             onEscape={() => setUrlOpen(false)}
							             placeholder={t.refPlaceholder} style={{ minWidth: 300 }} />
						</label>
						<div className="hint" style={{ margin: "6px 0 8px", maxWidth: 340 }}>
							{t.refBaseSet ? (
								<>Opens via this browser's link base.{" "}
									{t.refTestUrl && <a href={t.refTestUrl} target="_blank" rel="noopener noreferrer">test ↗</a>}</>
							) : (
								<>No link base set for this plan in this browser, so references do not become links. Settings → Links.</>
							)}
						</div>
						<label className="lbl">Direct link
							<CommitField ref={url} type="url" id="url" value={t.url}
							             commit={v => { setUrlOpen(false); p.onUrl(v); }}
							             onEscape={() => setUrlOpen(false)}
							             placeholder="https://…" style={{ minWidth: 300 }} />
						</label>
						<div className="hint" style={{ marginTop: 6, maxWidth: 340 }}>
							Overrides the reference link for this one task.
						</div>
					</div>
				</span>
				<button id="dup" title="Duplicate this task" onClick={p.onDup}>Duplicate</button>
				<button id="up" disabled={t.queueDisabled} onClick={() => p.onMove(-1)}
				        title={t.queueTitle("Earlier in this team's queue")}>↑</button>
				<button id="down" disabled={t.queueDisabled} onClick={() => p.onMove(1)}
				        title={t.queueTitle("Later in this team's queue")}>↓</button>
				<button id="del" title="Delete this task" aria-label="Delete this task" onClick={p.onDelete}>🗑</button>
				<button id="dismiss" title="Close (Esc)" onClick={p.onDismiss}>×</button>
			</div>

			{/* WRAPPED, so one rule can turn the stack into two columns at full size
			    and the existing folded rule can hide the pair in one go. */}
			<div className="ibody">
			<div className="idesc">
				{/* A TEXTAREA, NOT AN INPUT. It was a single-line <input>, which cannot
				    show or edit a description of any length — and every task on a real
				    plan has one now. Resizable by hand as well, because a guess about
				    how much room you want is still a guess.
				    An empty description opens straight into the textarea: there is
				    nothing to render, and a blank box you must click first to type in
				    is a worse empty state than one you can just type in. */}
				{editing || !t.desc
					? <textarea ref={desc} id="desc" value={t.desc}
					            placeholder="description — the detail that used to bloat the title"
					            onChange={e => p.onDesc(e.target.value)}
					            // FOCUS IS EDITING. An EMPTY description shows this box without
					            // `editing` being set, so the first letter typed made the text
					            // non-empty, the condition above flipped to the rendered view,
					            // and the box — with the caret in it — was unmounted.
					            onFocus={() => setEditing(true)}
					            onKeyDown={e => {
					              // ESCAPE LEAVES THE FIELD, NOT THE TASK. The page's global
					              // Escape clears the selection, which would shut the panel on
					              // someone who only meant to stop editing. Same carve-out
					              // `CommitField` makes, for the same reason.
					              if (e.key === "Escape") { setEditing(false); e.stopPropagation(); }
					            }}
					            onBlur={() => setEditing(false)} />
					/* `dangerouslySetInnerHTML` is the honest name and the safe case:
					   `mdHtml` escapes every character of the input before it writes a
					   single tag, so nothing here came from the person who typed it. */
					: <div className="mdview" title="Click to edit" tabIndex={0}
					       onClick={() => setEditing(true)}
					       onFocus={() => setEditing(true)}
					       dangerouslySetInnerHTML={{ __html: t.descHtml }} />}
			</div>
			{/* A LAYOUT, NOT A FLOW. This was one flex-wrap row, so every field's x
			    depended on how wide everything before it happened to be — a longer
			    "Changed" line or a second project pushed the rest along and wrapped
			    a different field onto the next line on every task. Now there are
			    one grid of equal cells for everything you set, then one line of what
			    the scheduler says back. A field's place depends on the window
			    width and nothing else. */}
			<div className="ifields" style={{ marginTop: 8 }}>
				<div className="fgroup">
				{/* TEXT, NOT NUMBER, because the unit is part of the value. A number
				    input cannot hold "2h", and the alternative — a separate unit
				    dropdown — spends a control on something a suffix says better. A
				    bare number still means days, which is what every plan already in
				    S3 says and what an agent writing one will type. */}
				{row("Duration", "How long the work takes, in hours and minutes: 2h, 45m, 1h30m. Stored as whole minutes of work; with working hours set, only time inside that window counts.",
					<CommitField key="d" type="text" id="dur" value={t.dur} placeholder="8h / 1h30m / 45m"
					             commit={p.onDur} />)}
				{sel("lane", t.labels.lanes, t.lanes, t.lane, p.onLane)}
				{t.colors && (
					<label className="frow"><span className="fk">{t.labels.colors}</span><span className="fv popwrap">
						{/* A DROPDOWN, LIKE EVERY OTHER CHANNEL. This was a row of toggle
						    chips, which is the better gesture in isolation and the wrong
						    one here: it grows with the number of colours, and every pixel
						    the inspector takes is a pixel of plan. Still multi-select,
						    because colour is still a list — it just opens rather than
						    sprawling. */}
						<button id="colr" ref={colr.btn} className="pickbtn" title="Choose one or more"
						        onClick={e => { e.stopPropagation(); setColrOpen(o => !o); }}>
							{t.colorSummary}<i>▾</i>
						</button>
						<div id="colrpop" ref={colr.pop} hidden={!colrOpen}>
							{t.colors.map(c => (
								<label key={c.id} className="cpick">
									<input type="checkbox" data-col={c.id} checked={c.on}
									       onChange={() => p.onColors(
									         // Order follows doc.colors, not click order, so the bands read
									         // left-to-right in the same sequence as the legend and two tasks
									         // with the same pair look the same.
									         t.colors!.filter(x => x.id === c.id ? !x.on : x.on).map(x => x.id))} />
									<span className="k" style={{ backgroundColor: c.color }}></span>{c.label}
								</label>
							))}
						</div>
					</span></label>
				)}
				{/* ONE VALUE IS NOT A CHOICE, and there is NO BLANK OPTION: since v3 a
				    not-applicable border is a VALUE in the list, usually labelled with a
				    dash. Clearing a task's environment is picking that value, not
				    emptying a field. */}
				{sel("bord", t.labels.borders, t.borders, t.border, v => p.onChannel("border", v))}
				{sel("fill", t.labels.fills, t.fills, t.fill, v => p.onChannel("fill", v))}
				{sel("shp", t.labels.shapes, t.shapes, t.shape, v => p.onChannel("shape", v))}
				{/* A MILESTONE IS NOT A CHANNEL and has its own command: "belongs to no
				    milestone" is a real state, and `setTaskChannel` may not carry an
				    empty value. */}
				{sel("ms", "Milestone", t.milestones, t.ms, p.onMilestone)}
				{/* NAMED FOR WHAT IT DOES, not for the mechanism. "Ignores the queue"
				    describes an implementation — a lane is a serial queue and this
				    task neither waits for a slot nor holds one — which tells you
				    nothing about when you would want it. What you observe is that the
				    work happens alongside everything else instead of taking its turn. */}
				{row("Run in parallel", "This task does not take its turn in its team's queue: it neither waits for a free slot nor occupies one, so it can overlap everything else. For work that does not consume the team — waiting on someone else, a request you have raised — where the lane still says whose it is.",
					<label key="s" className="fswitch">
						<input type="checkbox" id="noq" checked={t.noQueue}
						       onChange={e => p.onNoQueue(e.target.checked)} />
						{/* SAYS WHAT IT IS SET TO. A bare 22px switch in a cell of full-height
						    controls read as missing rather than off. */}
						<span>{t.noQueue ? "runs alongside everything" : "takes its turn"}</span>
					</label>)}
				
				{row("Not before", "Start no earlier than — a constraint the scheduler honours, not a position",
					<input key="i" type="datetime-local" id="nb" value={t.notBefore}
					       onChange={e => p.onNotBefore(e.target.value)} />,
					nowBtn("nbn", p.onNotBefore, "Not before this moment"),
					clear("nbx", t.notBefore, "Clear the start constraint", () => p.onNotBefore("")))}
				{/* THE OTHER DIRECTION FROM "Not before", and sitting next to it for
				    exactly that reason: one is a floor on starting, this is a ceiling
				    on finishing. It constrains nothing — the scheduler ignores it —
				    and exists to be compared against the date the scheduler computes,
				    which is what `dueSlack` says. */}
				{row("Due", "When this task must finish by. Unlike a milestone, which dates an outcome several tasks feed, this belongs to the one task. The scheduler does not honour it — it reports against it.",
					<input key="i" type="datetime-local" id="due" value={t.due}
					       onChange={e => p.onDue(e.target.value)} />,
					nowBtn("duen", p.onDue, "Due now"),
					clear("duex", t.due, "Clear the deadline", () => p.onDue("")))}
				{/* A PLAN IS A CLAIM, A SESSION IS A FACT. Planned stretches are the times this task is promised to happen: the
				    scheduler holds them and works the rest of the plan around them. ✓ says it happened (it becomes a session, with the
				    times to correct); × deletes the claim. A stretch that is over and neither is unconfirmed, and asks what Review → Past plans asks. */}
				{t.done ? null : row("Plan", "Times this task is promised to happen, in wall-clock time whatever the working hours say. Other work flows around them and the task does not take its turn in the queue. It ignores what it waits on, so check the slack. ✓ on a stretch says it happened and turns it into a session; × deletes it.",
					<button key="b" id="planadd" className="fnow" title="Promise a stretch of time, from the next hour for the estimate" onClick={p.onPlanAdd}>plan</button>)}
				{t.done ? null : t.planned.flatMap((x, i) => [
					row(`Plan in #${i + 1}${x.unconfirmed ? " · unconfirmed" : ""}`, x.unconfirmed ? "This stretch is over and nobody has said whether it happened. Answer here or in Review → Past plans." : "When this stretch is promised to begin.",
						<input key="i" type="datetime-local" id={`ps${i}`} value={x.start}
						       onChange={e => p.onPlanned(i, "start", e.target.value)} />,
						...(x.unconfirmed ? [
							<PastAnswerBox key="a" plan={x.unconfirmed} onAnswer={p.onPastAnswer} keys={false} />,
						] : [
							<button key="d" id={`pd${i}`} className="fnow" title="It happened: record it as a session" onClick={() => p.onPlannedDone(i)}>✓</button>,
							<button key="x" id={`px${i}`} className="fclear" title="Delete this planned stretch" onClick={() => p.onPlannedRemove(i)}>×</button>,
						])),
					row(`Plan out #${i + 1}`, "When this stretch is promised to end.",
						<input key="i" type="datetime-local" id={`pe${i}`} value={x.stop} min={x.start || undefined}
						       onChange={e => p.onPlanned(i, "stop", e.target.value)} />),
				])}
				{/* A RULE IS SET ONCE AND ONLY ITS LOOK-AHEAD EDITED: the copies already made were dated by it, so changing the
				    interval means stopping the series and starting another. Needs a Not before or a Due, which is the first occurrence. */}
				{t.recur
					? row("Repeats", "Every copy is an ordinary task that keeps this one's sign-off. Finishing a copy adds the next; the number is how many copies wait beyond the open one. × stops the series.",
						<span key="r" id="rec">every {t.recur.n} {t.recur.unit}{t.recur.n > 1 ? "s" : ""}, </span>,
						<input key="a" type="number" id="reca" min={0} max={30} style={{ width: "3.5em" }} value={t.recur.ahead}
						       onChange={e => p.onRecur({ ...t.recur!, ahead: Math.max(0, Math.min(30, +e.target.value || 0)) })} />,
						<span key="l"> ahead</span>,
						clear("recx", "1", "Stop repeating", () => p.onRecur(null)))
					: row("Repeats", "Make this task come round on the calendar, counted from its Not before (or its Due, if it has no start). Each copy keeps the sign-off.",
						<span key="r">every </span>,
						<input key="n" type="number" id="recn" min={1} max={999} style={{ width: "3.5em" }} value={every.n}
						       onChange={e => setEvery({ ...every, n: Math.max(1, +e.target.value || 1) })} />,
						<select key="u" id="recu" value={every.unit} onChange={e => setEvery({ ...every, unit: e.target.value })}>
							{["day", "week", "month"].map(u => <option key={u} value={u}>{u}{every.n > 1 ? "s" : ""}</option>)}
						</select>,
						<button key="b" id="recb" className="fnow" disabled={!t.notBefore && !t.due}
						        title={t.notBefore || t.due ? "Start repeating" : "Set a Not before or a Due first: it is the first occurrence"}
						        onClick={() => p.onRecur({ ...every, ahead: 1 })}>repeat</button>)}
				{/* WORK IS START/STOP, then FINISH, and each stretch is editable, so a forgotten stop is put back to 4pm
				    rather than left reading as an all-nighter. The sessions are the only record (ADR 0016): the task
				    started at the first start and, once finished, ended at the last stop. None of this voids a sign-off. */}
				{row("Work", "Start and stop as you work on this; stopping is pausing. Finish when it is done — work never started gets a moment of no length, now. What is left of the estimate is forecast from now. Times are wall clock. Any stretch can be edited below.",
					t.done ? null : t.sessions.some(x => !x.stop)
						? <button key="b" id="workstop" className="fnow" onClick={p.onStopTask}>stop</button>
						: <button key="b" id="workstart" className="fnow" onClick={p.onStartTask}>start</button>,
					t.done
						? <button key="f" id="workreopen" className="fnow" title="Not finished after all — back to paused, sessions kept" onClick={p.onReopenTask}>reopen</button>
						: <button key="f" id="workfinish" className="fnow" title="Finished just now" onClick={p.onFinishTask}>finish</button>,
					t.worked ? <span key="w" id="worked">{t.worked}</span> : null)}
				{t.sessions.flatMap((x, i) => [
					row(`In #${i + 1}`, "When this stretch of work began.",
						<input key="i" type="datetime-local" id={`ss${i}`} value={x.start}
						       onChange={e => p.onSession(i, "start", e.target.value)} />,
						t.sessions.length > 1
							? <button key="x" id={`sx${i}`} className="fclear" title="Remove this stretch"
							          onClick={() => p.onRemoveSession(i)}>×</button>
							: <span key="x" className="fclear" title="The last stretch stays: worked-on work cannot be un-started. Split the task to start over." />),
					row(`Out #${i + 1}`, "When it ended. Empty while it is still running.",
						<input key="i" type="datetime-local" id={`se${i}`} value={x.stop} min={x.start || undefined}
						       onChange={e => p.onSession(i, "stop", e.target.value)} />,
						nowBtn(`sen${i}`, iso => p.onSession(i, "stop", iso), "Stopped just now")),
				])}
				{/* LAST IN THE RAIL, because it is the same kind of thing as the two
				    above it: a fact about the past, not a constraint on the future.
				    `max` for the same reason they have one — you cannot have read
				    something tomorrow.

				    THE ONE FIELD THAT CLEARS ITSELF. Editing the title, description
				    or duration empties this, in the shared applier, wherever the edit
				    came from — so a sign-off always refers to the wording in front of
				    you. That is the whole point of it; see `edited` in
				    shared/commands.ts. */}
				{row("Refined", "When somebody last read this task and agreed with its title, description and duration. Changing any of those three clears it — the sign-off was about that wording. Until it is set, the task reads as Unrefined and does not count as Ready now.",
					<input key="i" type="datetime-local" id="ref-at" max={t.todayISO} value={t.refinedAt}
					       onChange={e => p.onRefined(e.target.value)} />,
					nowBtn("refn", p.onRefined, "Refined just now — I have read this and I agree with it"),
					clear("refx", t.refinedAt, "Withdraw the sign-off — back to unrefined", () => p.onRefined("")))}
				</div>
				{/* READ-ONLY, so it is not mixed in among the editors. These are answers
				    the scheduler computed and facts nobody edits here; everything above
				    is something you tell it. Free text, and last, so however long it
				    runs it cannot move a control. */}
				<div className="finfo">
					<span>starts <b>{t.startsText}</b> · ends <b>{t.endsText}</b></span>
					{t.dueSlack && <span id="dueslack" style={{ color: `var(--${t.dueSlack.tone})` }}>
						{t.dueSlack.text}</span>}
					{t.est && <span id="est" style={{ color: `var(--${t.est.tone})` }}>{t.est.text}</span>}
					{t.variance && <span id="var" title={t.variance.title}>{t.variance.text}</span>}
					{t.rank && <span title="Where this sits in the plan's “which should happen first?” ranking — answered in Review → Rank. Auto-order uses it to break ties once the dates are equal; it never makes anything later.">
						rank <b id="rankval">{t.rank}</b></span>}
					{/* "Edited" moves only when the title, description or duration
					    changes — exactly what voids a sign-off — so it and Refined talk
					    about the same event. */}
					{t.touched && <span id="touched" title="When this task was added, and when its wording last changed. Moving it, linking it or recording work on it is not a change to what it says, so neither moves this.">
						{t.touched}</span>}
				</div>
			</div>

			{/* EVERY RELATIONSHIP GETS ITS OWN ROW, ALWAYS — a dash when there is
			    nothing, so the rows never jump when a task gains its first blocker.
			    One grid, so the chips all start at the same x. "Queued behind" used
			    to trail off the end of "Waits directly for" as though it were one of
			    its chips. Each link button sits on the row it fills. */}
			<div className="deps">
				<div className="deprow">
					<span className="dk" style={{ color: t.depColors.direct }}>Waits directly for</span>
					<span className="dchips">{t.deps.length
						? <Chips list={t.deps} onGo={p.onGo} onRemoveDep={p.onRemoveDep} onChipHover={p.onChipHover} />
						: <span className="hint">{t.noDepsHint}</span>}</span>
					<button id="mklinkwaits" onClick={p.onStartLinkWaits}
					        title="Pick the task THIS one has to wait for — it lands in “Waits directly for”">
						Waits for…
					</button>
				</div>
				{t.trans.length > 0 && (
					<div className="deprow">
						<span className="dk" style={{ color: t.depColors.trans }}>…which in turn wait for</span>
						<span className="dchips"><Chips list={t.trans} onGo={p.onGo} onRemoveDep={p.onRemoveDep} onChipHover={p.onChipHover} /></span>
					</div>
				)}
				<div className="deprow">
					<span className="dk heldk">{t.heldLabel}</span>
					<span className="dchips">{t.heldBy.length
						? <Chips list={t.heldBy} onGo={p.onGo} onRemoveDep={p.onRemoveDep} onChipHover={p.onChipHover} />
						: <span className="hint">{t.noDepsHint}</span>}</span>
				</div>
				<div className="deprow">
					<span className="dk" style={{ color: t.depColors.down }}>Nothing else can start until this is done</span>
					<span className="dchips">{t.blocks.length
						? <Chips list={t.blocks} onGo={p.onGo} onRemoveDep={p.onRemoveDep} onChipHover={p.onChipHover} />
						: <span className="hint">{t.noDepsHint}</span>}</span>
					<button id="mklink" onClick={p.onStartLink}
					        title="Pick the task that has to wait for THIS one — this task becomes its blocker">
						Blocks…
					</button>
				</div>
			</div>
			<Comments list={t.comments} p={p} />
			</div>
		</>
	);
}

// COMMENTS, oldest first like a GitHub issue — the conversation ON the task, as
// opposed to the description above, which is what the task IS. Nothing here
// touches the sign-off. It does NOT scroll itself into view: that used to run when a task was opened,
// and sent the whole panel to the bottom (2026-10-04).
function Comments({ list, p }: { list: InspectorTask["comments"]; p: InspectorProps }) {
	const [draft, setDraft] = useState("");
	const [editing, setEditing] = useState<Id | null>(null);
	const [edit, setEdit] = useState("");
	const post = () => { if (draft.trim()) { p.onAddComment(draft.trim()); setDraft(""); } };
	return (
		<div className="comments" id="comments">
			<span className="dk">Comments{list.length ? ` · ${list.length}` : ""}</span>
			{list.map(c => (
				<div key={c.id} className="comment" data-comment={c.id}>
					<div className="chead">
						<b>{c.by}</b> <span className="cwhen">{c.when}</span>
						{c.edited && <span className="cedited" title={`Edited ${c.edited}`}> · edited</span>}
						<span className="cact">
							<button title="Edit this comment" data-cedit={c.id}
							        onClick={() => { setEditing(c.id); setEdit(c.text); }}>edit</button>
							<button title="Delete this comment" data-cdel={c.id}
							        onClick={() => p.onRemoveComment(c.id)}>×</button>
						</span>
					</div>
					{editing === c.id
						? <div className="cform">
							<textarea value={edit} onChange={e => setEdit(e.target.value)} autoFocus
							          onKeyDown={e => { if (e.key === "Escape") { setEditing(null); e.stopPropagation(); }
							                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { p.onEditComment(c.id, edit); setEditing(null); } }} />
							<button onClick={() => { if (edit.trim()) p.onEditComment(c.id, edit); setEditing(null); }}>Save</button>
							<button onClick={() => setEditing(null)}>Cancel</button>
						  </div>
						: <div className="mdview" dangerouslySetInnerHTML={{ __html: c.html }} />}
				</div>
			))}
			<div className="cform">
				<textarea id="newcomment" value={draft} placeholder="Add a comment — Markdown; ⌘↵ to post"
				          onChange={e => setDraft(e.target.value)}
				          onKeyDown={e => { if (e.key === "Escape") e.stopPropagation();
				                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); }} />
				<button id="postcomment" disabled={!draft.trim()} onClick={post}>Comment</button>
			</div>
		</div>
	);
}
