// THE TWO EDITORS THAT ARE REBUILT ON EVERY RENDER.
//
// `#wwedit` and `#arrowedit` live inside Settings, which is usually shut — and
// both were `innerHTML =` on the render path anyway, so every keystroke anywhere
// in the plan rebuilt two panels nobody was looking at. That is the render model's
// cost in its purest form: work proportional to the whole page, paid per edit.
//
// Presentation only, like the rest of `ui/`. Neither knows what a working day is;
// `app.ts` hands them a mask and a list.
import { useState } from "react";
import type { CSSProperties } from "react";
import { ColorField } from "./fields.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface WeekEditorProps {
	/** Seven slots indexed the way `getUTCDay()` counts — 0 is Sunday. */
	mask: number[];
	/** ISO dates nobody works, whatever the weekday. Already sorted. */
	holidays: string[];
	/** The working window of each working day, or null for the whole day. */
	hours: [string, string] | null;
	onHours: (v: [string, string] | null) => void;
	/** The day a week begins on, `getUTCDay()` numbering. */
	weekStart: number;
	onWeekStart: (v: number) => void;
	onToggleDay: (i: number) => void;
	onAddHoliday: (iso: string) => void;
	onRemoveHoliday: (iso: string) => void;
}

/** THE WORKING WEEK AND THE DAYS OFF, in one editor because they answer the same
 *  question — does work happen — and differ only in what they are asked about. */
export function WeekEditor(p: WeekEditorProps) {
	const [pending, setPending] = useState("");
	const per = p.mask.reduce((a, b) => a + (b ? 1 : 0), 0);
	const add = () => {
		if (!pending) return;
		p.onAddHoliday(pending);
		// CLEARED ON ADD, which the imperative version got for free: it rebuilt the
		// whole panel from `innerHTML`, so the date input came back empty whether
		// anyone wanted that or not. Keeping the field populated after adding it to
		// the list would read as "this has not been accepted".
		setPending("");
	};
	return (
		<>
			<div className="toolbar" style={{ marginTop: 10 }}>
				<span className="lbl">Working week</span>
				{DOW.map((d, i) => (
					<button key={d} className={`dow${p.mask[i] ? "" : " off"}` } data-dow={i}
					        title={p.mask[i] ? "Worked — click to turn off" : "Not worked — click to turn on"}
					        onClick={() => p.onToggleDay(i)}>{d}</button>
				))}
				<span className="sep"></span>
				<span className="lbl" style={{ color: "var(--muted)" }}>{per} {per === 1 ? "day" : "days"} a week</span>
			</div>
			<div className="toolbar" style={{ marginTop: 10 }}>
				<label className="lbl" title="Where the calendar starts its week and the timeline draws its week rules. The scheduler does not read it.">Week starts
					<select id="weekstart" value={p.weekStart} onChange={e => p.onWeekStart(+e.target.value)}>
						{DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
					</select></label>
			</div>
			<div className="toolbar" style={{ marginTop: 10 }}>
				{/* ONE WINDOW, SAME DAY (ADR 0014). A start at or after the end is not sent —
				    that is a half-typed edit, and the server would refuse it anyway. */}
				<span className="lbl">Working hours</span>
				{([0, 1] as const).map(k => (
					<input key={k} type="time" id={k ? "hoursto" : "hoursfrom"}
					       value={(p.hours || ["00:00", "24:00"])[k] === "24:00" ? "23:59" : (p.hours || ["00:00", "24:00"])[k]}
					       onChange={e => {
						       const v: [string, string] = [...(p.hours || ["00:00", "24:00"])] as [string, string];
						       v[k] = e.target.value;
						       if (v[0] && v[1] && v[0] < v[1]) p.onHours(v);
					       }} />
				))}
				<button id="hoursall" disabled={!p.hours} title="Work can happen at any hour of a working day"
				        onClick={() => p.onHours(null)}>All day</button>
			</div>
			<div className="toolbar" style={{ marginTop: 10 }}>
				<label className="lbl">Days off
					<input type="date" id="holnew" value={pending}
					       onChange={e => setPending(e.target.value)}
					       onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
				</label>
				<button id="holadd" onClick={add}>Add</button>
			</div>
			<div style={{ marginTop: 8 }}>
				{p.holidays.length
					? p.holidays.map(h => (
						<span key={h} className="hol">{h}
							<button data-hol={h} title="Remove" onClick={() => p.onRemoveHoliday(h)}>×</button>
						</span>
					))
					: <span className="lbl" style={{ color: "var(--muted)" }}>None yet.</span>}
			</div>
		</>
	);
}

export interface ArrowRow {
	k: string;
	label: string;
	color: string;
	dash: boolean;
}

export interface ArrowEditorProps {
	arrows: ArrowRow[];
	onColor: (k: string, color: string) => void;
	onDash: (k: string, dash: boolean) => void;
}

export function ArrowEditor(p: ArrowEditorProps) {
	return (
		<>{p.arrows.map(a => (
			<div key={a.k} className="arrit">
				{/* The swatch is a line rather than a block because "dashed" is a
				    property of the line and a block cannot show it. */}
				<svg width="34" height="10" aria-hidden="true">
					<line x1="1" y1="5" x2="33" y2="5" stroke={a.color}
					      strokeWidth={a.dash ? 1.8 : 2.5} strokeDasharray={a.dash ? "5 4" : "none"} />
				</svg>
				<span className="lb">{a.label}</span>
				<ColorField data-ac={a.k} value={a.color} title="Line colour"
				            commit={c => p.onColor(a.k, c)} />
				<label>
					<input type="checkbox" data-ad={a.k} checked={a.dash}
					       onChange={e => p.onDash(a.k, e.target.checked)} /> dashed
				</label>
			</div>
		))}</>
	);
}

// ---------------------------------------------------------------------------
// THE SWATCH WALL — a static reference for every value each channel can take,
// including the ones no plan currently uses.
export interface SwatchRow {
	title: string;
	note: string;
	cells: { label: string; cls: string; style?: CSSProperties }[];
}

export function SwatchWall({ rows }: { rows: SwatchRow[] }) {
	const hue = "#5aa9f0";
	return (
		<>
			{rows.map(r => (
				<div key={r.title} className="swrow">
					<b>{r.title}</b>
					<span className="swnote">{r.note}</span>
					<div className="swgrid">
						{r.cells.map(c => (
							// NOT className="bar". It was, for one commit, on the theory that
							// reusing the real element guaranteed a faithful preview — and it
							// silently poisoned every `.bar` selector in the app and the test
							// suite. `#settings` sits before `#chart` in the document, so
							// `querySelector(".bar")` started returning a swatch inside a hidden
							// modal: the fixture's bar count went from 12 to 38 and the first
							// click of the suite landed on an invisible element. Nothing is lost
							// — `.bar` only supplies position and size, and every visual this
							// wall exists to show lives on `.shape`.
							<div key={c.label} className="swx">
								<div className="swbar">
									<div className={`shape ${c.cls}`} style={{ ...c.style, backgroundColor: hue }} />
								</div><span>{c.label}</span>
							</div>
						))}
					</div>
				</div>
			))}
			<div className="hint" style={{ marginTop: 10 }}>
				<b>Color</b> is a free hex — unlimited values, and the only channel a task can hold
				more than one of (drawn as bands). <b>Lanes</b> are unlimited too: a lane is a row
				group, so it has no style to run out of.
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------
// WHAT A ROW LABEL SAYS, as an ordered list.
export interface LabelPartsProps {
	on: { k: string; name: string }[];
	off: { k: string; name: string }[];
	/** The longest row label in the plan. The question people actually have is not
	 *  "what does it say" but "how much room does it need". */
	sample: string | null;
	onToggle: (k: string, enabled: boolean) => void;
	onMove: (k: string, dir: -1 | 1) => void;
}

export function LabelPartsEditor(p: LabelPartsProps) {
	const row = (k: string, name: string, i: number, enabled: boolean) => (
		<div key={k} className="chit" style={{ gridTemplateColumns: "1fr auto" }}>
			<label className="lbl" style={{ justifyContent: "flex-start" }}>
				<input type="checkbox" data-lp={k} checked={enabled} disabled={k === "title"}
				       title={k === "title" ? "The name always shows — move it, but it cannot be removed" : undefined}
				       onChange={e => p.onToggle(k, e.target.checked)} />
				{name}
			</label>
			<span className="btns">{enabled && <>
				<button data-lpmove={`${k}:-1`} disabled={i === 0} title="Move left"
				        onClick={() => p.onMove(k, -1)}>◀</button>
				<button data-lpmove={`${k}:1`} disabled={i === p.on.length - 1} title="Move right"
				        onClick={() => p.onMove(k, 1)}>▶</button>
			</>}</span>
		</div>
	);
	return (
		<div className="chrow">
			<div className="chhead"><span className="chwhat">row label — order runs left to right</span></div>
			<div className="chgrid">
				{p.on.map((e, i) => row(e.k, e.name, i, true))}
				{p.off.map(e => row(e.k, e.name, -1, false))}
			</div>
			{p.sample && <div className="hint" style={{ margin: "6px 0 0" }}>
				longest row reads <b>{p.sample}</b></div>}
		</div>
	);
}

// ---------------------------------------------------------------------------
// THE COLLAPSED TOP BAR'S ONE LINE: what plan this is, and whether it lands.
export function MiniChip(
	{ title, milestone, verdict, tone }:
	{ title: string; milestone: string; verdict: string; tone: string },
) {
	return <><b>{title}</b> · {milestone} <span style={{ color: tone, fontWeight: 700 }}>{verdict}</span></>;
}
