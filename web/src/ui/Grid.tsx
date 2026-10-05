// THE CHART ITSELF — lane heads, rows, labels and bars.
//
// This is the region ADR 0004 left imperative longest, and the reason is worth
// keeping in front of whoever changes it next: the chart's whole vocabulary is
// visual, and four of the things drawn here have each been got wrong once and
// fixed once. Every one of them is a comment in this file, and every one of them
// is in `scripts/grid-fingerprint.json` — a golden of the COMPUTED STYLE of every
// bar, shape, core, band, tick and strip in all three shapes the grid takes.
// A change that alters any of them fails the browser suite and names the property.
//
// PRESENTATION ONLY, like the rest of `ui/`. Every number here — where a bar
// starts, how wide it is, which track it sits on when a lane is folded — was
// computed by `app.ts` from the scheduler. This file cannot work out a date.
import { Fragment, useEffect } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent,
              KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Id } from "../types.js";

export interface LabelPart { text: string; title: boolean; tip?: string }

export interface GridBar {
	id: Id;
	/** "bar", plus `sel` / `pin` / `eyed`. */
	cls: string;
	left: number;
	width: number;
	/** Only the SQUEEZED fold divides the bar height between tracks. One row per
	 *  track keeps every bar full size, which is what makes that state editable. */
	height?: number;
	top?: number;
	title: string;
	label: string;
	colorsAttr: string;
	/** WORK SESSIONS, drawn on top of the bar: one segment per stretch (`run` while it is still going) and,
	 *  for unfinished work, a hatched `rest` from now to the forecast end. Left is relative to the bar. */
	segs?: { cls: string; left: number; width: number }[];
	/** `shape sh-<name>`, plus `fillbody pat-<x>` when the silhouette is rounded. */
	shapeCls: string;
	/** From `borderCss` — a declaration LIST, because rails and caps are two sides
	 *  and no shorthand says that. */
	shapeStyle: CSSProperties;
	/** A POINTED SHAPE PAINTS ITS OWN RIM. `.shape` becomes the rim, clipped to the
	 *  silhouette, and `.core` carries the fill inset 2px inside it — a CSS border
	 *  would be painted on the box edges and then cut, leaving the point with no
	 *  rim at all. */
	coreCls: string | null;
	/** The fill, assigned as a colour and never through the `background` shorthand:
	 *  the shorthand resets `background-image`, which is where the hatch lives. */
	bodyColor: string;
	/** A task with several systems is drawn as SEVERAL BANDS — real elements, not a
	 *  `linear-gradient`, for the same reason one layer up. They live inside
	 *  `.shape`, so a pointed silhouette clips them along with the body. */
	bands: { cls: string; left: string; right: string; color: string }[];
	/** A WHISKER WHEN THE ESTIMATE LANDS OUTSIDE the bar, where a lone mark in
	 *  whitespace would be attached to nothing. */
	estLead: { left: number; width: number } | null;
	/** A TICK, NOT A GHOST BAR: both extents share a left edge, so the estimate is
	 *  described completely by one x. Sibling of `.shape` like the grip, so a
	 *  pointed shape cannot clip it. */
	estTick: { cls: string; left: number; title: string } | null;
	/** The deadline marker, and the dashed leader out to it when it sits past the
	 *  bar's right edge. Absent on work with no `due`, and on anything finished or
	 *  finished — the same rule the Risk chips use. */
	dueLead: { left: number; width: number; late: boolean } | null;
	dueTick: { cls: string; left: number; title: string } | null;
	/** Below a threshold the grip is not RENDERED rather than hidden — an invisible
	 *  element still takes the pointer, which is the same bug with no affordance. */
	grip: boolean;
	eye: boolean;
}

export interface GridRow {
	key: string;
	cls: string;
	/** `data-task`. A folded lane reuses one row for several bars, so this is the
	 *  last of them — reproduced exactly as the imperative version left it. */
	taskId: Id;
	/** Every task drawn on this row, so `POS` can key the same element by each. */
	taskIds: Id[];
	/** Absent when folded: the lane head IS the label. */
	label: { done: boolean; sel: boolean; title: string; parts: LabelPart[];
	         link: string | null } | null;
	bars: GridBar[];
	strips: { cls: string; left: number; width: number }[];
}

export interface GridLane {
	key: string;
	/** Absent in date mode, which has no lane grouping. */
	/** `next` is the fold state a click moves to, decided where `tracks` is
	 *  known — a lane whose work never overlaps has nothing between the last
	 *  two states, so it cycles straight back to expanded. */
	head: { laneId: Id; text: string; title: string; width: number;
	        next: 't' | '1' | undefined } | null;
	rows: GridRow[];
}

export interface GridProps {
	lanes: GridLane[];
	/** AN EMPTY CHART MUST SAY WHY: filters are OR within a channel and AND across
	 *  them, so a blank chart otherwise looks like a broken tool. */
	nomatch: string | null;
	onFold: (laneId: Id, next: 't' | '1' | undefined) => void;
	onPick: (id: Id) => void;
	/** Hover lights the bar and redraws the arrows around it. */
	onHeat: (id: Id, on: boolean) => void;
	onBarDown: (e: ReactPointerEvent, id: Id) => void;
	onGripDown: (e: ReactPointerEvent, id: Id) => void;
	/** Hands `app.ts` the row element so `POS` can hold it — the ref map the
	 *  imperative version got for free by keeping the node it had just made. */
	registerRow: (ids: Id[], el: HTMLDivElement | null) => void;
	/** Called after every commit. The arrow layer measures `offsetTop` off the row
	 *  elements, so it cannot be drawn until they exist — and a `requestAnimation
	 *  Frame` scheduled by the caller BEFORE this commit fires first and finds
	 *  nothing. */
	onPainted: () => void;
}

/** Enter and Space do what a click does. Shared by both focusable things in
 *  here so a bar and a row label cannot disagree about which keys work. */
function activate(p: GridProps, id: Id) {
	return (e: ReactKeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		// Space scrolls the page and Enter bubbles to the document handler; both
		// would otherwise happen ON TOP of the cycle rather than instead of it.
		e.preventDefault(); e.stopPropagation();
		p.onHeat(id, false);
		p.onPick(id);
	};
}

/** THE BAR'S OWN LOOK (silhouette, rim, fill pattern, colour bands), so a work segment wears exactly what the
 *  whole bar does. */
function BarLook({ b }: { b: GridBar }) {
	const body = (
		<>
			{b.bands.map((n, i) => (
				<div key={i} className={n.cls}
				     style={{ left: n.left, right: n.right, backgroundColor: n.color }} />
			))}
		</>
	);
	return (
		<div className={b.shapeCls} style={{ ...b.shapeStyle,
		     ...(b.coreCls ? {} : { backgroundColor: b.bodyColor }) }}>
			{b.coreCls
				? <div className={b.coreCls} style={{ backgroundColor: b.bodyColor }}>{body}</div>
				: body}
		</div>
	);
}

/** `focusable` is FALSE on a labelled row, and that is the whole tab order: the
 *  label is the tab stop when there is one, the bars are when there is not (a
 *  folded lane has no per-task name). One stop per task either way — making both
 *  focusable would double the length of the chart for a keyboard and say the
 *  same thing twice. */
function Bar({ b, p, focusable }: { b: GridBar; p: GridProps; focusable: boolean }) {
	return (
		<div className={b.cls}
		     style={{ left: b.left, width: b.width,
		              ...(b.height != null ? { height: b.height, top: b.top } : {}) }}
		     data-viz-id={`bar-${b.id}`} data-label={b.label} data-colors={b.colorsAttr}
		     title={b.title}
		     {...(focusable ? { tabIndex: 0, role: "button", "aria-label": b.label,
		                        onKeyDown: activate(p, b.id) } : {})}
		     onClick={e => { e.stopPropagation(); p.onPick(b.id); }}
		     // Body drag = start constraint, right-edge grip = duration. Two different
		     // edits, deliberately not overloaded onto one handle.
		     onPointerDown={e => p.onBarDown(e, b.id)}
		     // Hover previews the same relationships selection shows, without changing
		     // selection — so you can trace a chain with the mouse while the inspector
		     // keeps showing the task you are actually editing.
		     onPointerEnter={() => p.onHeat(b.id, true)}
		     onPointerLeave={() => p.onHeat(b.id, false)}>
			<BarLook b={b} />
			{(b.segs || []).map((g, i) => g.cls === "wgap"
				? <div key={i} className="wgap" style={{ left: g.left, width: g.width }} />
				: <div key={i} className={g.cls} style={{ left: g.left, width: g.width }}><BarLook b={b} /></div>)}
			{b.estLead && <div className="estlead" style={{ left: b.estLead.left, width: b.estLead.width }} />}
			{b.estTick && <div className={b.estTick.cls} style={{ left: b.estTick.left }} title={b.estTick.title} />}
			{b.dueLead && <div className={"duelead" + (b.dueLead.late ? " late" : "")}
			                   style={{ left: b.dueLead.left, width: b.dueLead.width }} />}
			{b.dueTick && <div className={b.dueTick.cls} style={{ left: b.dueTick.left }} title={b.dueTick.title} />}
			{/* The grip stops its own pointerdown propagating, so it never reaches the
			    body drag underneath it. */}
			{b.grip && <div className="grip" onPointerDown={e => p.onGripDown(e, b.id)} />}
			{b.eye && <div className="eyemark">👁</div>}
		</div>
	);
}

export function Grid(p: GridProps) {
	useEffect(() => { p.onPainted(); });
	return (
		<>
			{/* A KEYED FRAGMENT, not a wrapper div. `display:contents` would have been
			    invisible to layout but still a node in the tree, and the gridlines,
			    the arrow layer and the cursor layer are all `position:absolute` against
			    `#grid` — so the safest change to that tree is no change at all. */}
			{p.lanes.map(lane => (
				<Fragment key={lane.key}>
					{lane.head && (
						// The chevron is the whole affordance. A lane head was already the
						// only thing in the gutter you could not click, which made it look
						// like a caption.
						<div className="lane-head fold" title={lane.head.title}
						     style={{ paddingLeft: 0, width: lane.head.width, textAlign: "right" }}
						     onClick={e => { e.stopPropagation(); p.onFold(lane.head!.laneId, lane.head!.next); }}>
							{lane.head.text}
						</div>
					)}
					{lane.rows.map(r => (
						<div key={r.key} className={r.cls} data-task={r.taskId}
						     ref={el => p.registerRow(r.taskIds, el)}>
							{r.label && (
								// THE NAME IS THE ROW. The label column is the index of this
								// chart, and an index you cannot click is a caption — so it does
								// what the bar does: hover previews the chain, click selects.
								// It borrows `.hot` from the dependency chips rather than
								// inventing a second highlight, and for the same reason they
								// need it: the pointer is a long way from the bar.
								// TAB REACHES IT, ENTER AND SPACE WORK IT. It was a bare div with
								// an onClick, so the whole chart was unreachable without a mouse —
								// not "the cycle did not advance", but no way to select a task at
								// all. `title` is already the long form, so it doubles as the
								// accessible name rather than inventing a second one to drift.
								// `.sel`, THE SAME WORD THE BAR USES, because it is the same
								// state — the name and the bar are two views of one task and two
								// vocabularies for "selected" would be two things to learn.
								// `aria-current` BECAUSE THE CLASS IS NOW ONLY A COLOUR. This
								// shipped with a tick beside the name too and Rascal Two took it out
								// — colour was enough for him — so this attribute is the whole of
								// what a reader who cannot see the accent gets, and "which one am
								// I on" is exactly the question this task was filed about.
								<div className={`rowlabel${r.label.done ? " done" : ""}${r.label.sel ? " sel" : ""}`}
								     title={r.label.title} aria-current={r.label.sel || undefined}
								     tabIndex={0} role="button" aria-label={r.label.title}
								     onKeyDown={activate(p, r.taskId)}
								     onFocus={() => p.onHeat(r.taskId, true)}
								     onBlur={() => p.onHeat(r.taskId, false)}
								     onPointerEnter={() => p.onHeat(r.taskId, true)}
								     onPointerLeave={() => p.onHeat(r.taskId, false)}
								     onClick={e => { e.stopPropagation(); p.onHeat(r.taskId, false); p.onPick(r.taskId); }}>
									{r.label.parts.map((part, i) => (
										<span key={i} className={part.title ? "rl-title" : "rl-chip"} title={part.tip}>
											{part.text}
										</span>
									))}
									{/* LAST, SO IT IS RIGHTMOST — the gutter is right-aligned, so
									    the arrow lands in the same column on every row that has
									    one. A REAL ANCHOR, not a click handler on a span:
									    middle-click, cmd-click and "copy link address" are gestures
									    people already have, and a handler would take all three away
									    to reimplement one. */}
									{r.label.link && (
										<a className="rl-link" href={r.label.link} target="_blank"
										   rel="noopener noreferrer" title={"Open " + r.label.link}
										   onClick={e => e.stopPropagation()}>↗</a>
									)}
								</div>
							)}
							{r.bars.map(b => <Bar key={b.id} b={b} p={p} focusable={!r.label} />)}
							{r.strips.map((s, i) => (
								<div key={i} className={s.cls} style={{ left: s.left, width: s.width }} />
							))}
						</div>
					))}
				</Fragment>
			))}
			{p.nomatch && <div className="nomatch" id="nomatch">{p.nomatch}</div>}
		</>
	);
}
