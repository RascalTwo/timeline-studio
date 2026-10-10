// THE TWO EDITORS THAT ARE REBUILT ON EVERY RENDER.
//
// `#wwedit` and `#arrowedit` live inside Settings, which is usually shut — and
// both were `innerHTML =` on the render path anyway, so every keystroke anywhere
// in the plan rebuilt two panels nobody was looking at. That is the render model's
// cost in its purest form: work proportional to the whole page, paid per edit.
//
// Presentation only, like the rest of `ui/`. Neither knows what a working day is;
// `app.ts` hands them windows as `["HH:MM", "HH:MM"]` pairs and takes edits back.
import { useState } from "react";
import type { CSSProperties } from "react";
import { ColorField } from "./fields.js";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Rows run Monday to Sunday; every index below is still `getUTCDay()`'s (0 is Sunday). */
const ROWS = [1, 2, 3, 4, 5, 6, 0];

export type Win = [string, string];

export interface WeekEditorProps {
	/** The windows of each weekday, Sunday first. */
	week: Win[][];
	/** Whether any weekday has a window. When none does the plan has no hours set, every hour works, and an empty row says so. */
	anyHours: boolean;
	/** Date overrides from today on, sorted; `[]` is a day off. Earlier ones are history and not listed. */
	dates: [string, Win[]][];
	/** Today's date, the earliest an override can be added for. */
	today: string;
	onWeek: (i: number, w: Win[]) => void;
	/** `null` removes the override. */
	onDate: (iso: string, w: Win[] | null) => void;
	/** The day a week begins on, `getUTCDay()` numbering. */
	weekStart: number;
	onWeekStart: (v: number) => void;
}

const mins = (hm: string) => +hm.slice(0, 2) * 60 + +hm.slice(3);
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** ONE DAY'S WINDOWS: a pair of time inputs each, × to remove, + to add. Empty reads `off`. */
function Windows(p: { label: string; windows: Win[]; off: string; onChange: (w: Win[]) => void }) {
	const last = p.windows[p.windows.length - 1];
	// A new window opens an hour after the last one ends and runs to midnight; with no window it is 09:00–17:00.
	const next: Win = last ? [hm(mins(last[1]) + 60), "24:00"] : ["09:00", "17:00"];
	const edit = (i: number, k: 0 | 1, v: string) => {
		if (!v) return;                                  // a cleared time input is a half-typed edit
		p.onChange(p.windows.map((w, j) => (j === i ? (k ? [w[0], v] : [v, w[1]]) : w) as Win));
	};
	return (
		<span className="hwins">
			{p.windows.length
				? p.windows.map((w, i) => (
					<span key={i} className="hwin">
						{/* type=time cannot show "24:00", so a window ending at midnight reads 23:59 until edited. */}
						<input type="time" className="hs" aria-label={`${p.label} window ${i + 1} start`} value={w[0]}
						       onChange={e => edit(i, 0, e.target.value)} />
						<span aria-hidden="true">–</span>
						<input type="time" className="he" aria-label={`${p.label} window ${i + 1} end`}
						       value={w[1] === "24:00" ? "23:59" : w[1]}
						       onChange={e => edit(i, 1, e.target.value)} />
						<button className="hrm" aria-label={`Remove ${p.label} window ${i + 1}`} title="Remove this window"
						        onClick={() => p.onChange(p.windows.filter((_, j) => j !== i))}>×</button>
					</span>
				))
				: <span className="lbl hoff">{p.off}</span>}
			<button className="hadd" aria-label={`Add a window to ${p.label}`} title="Add a window"
			        disabled={!!last && mins(last[1]) + 60 >= 1440}
			        onClick={() => p.onChange([...p.windows, next])}>+ add</button>
		</span>
	);
}

/** THE WORKING CALENDAR (ADR 0021): hours per weekday, and hours per date that replace their weekday's. */
export function WeekEditor(p: WeekEditorProps) {
	const [pending, setPending] = useState("");
	const add = () => {
		if (!pending) return;
		// A new date starts as a day off — the common case, a holiday — and takes windows from there.
		p.onDate(pending, []);
		// CLEARED ON ADD, which the imperative version got for free: it rebuilt the
		// whole panel from `innerHTML`, so the date input came back empty whether
		// anyone wanted that or not. Keeping the field populated after adding it to
		// the list would read as "this has not been accepted".
		setPending("");
	};
	return (
		<div role="group" aria-label="Working hours">
			<div className="hint" style={{ marginTop: 10 }}>
				No hours set means every hour is working time. Give a weekday a window and each weekday without one is a day off.
			</div>
			{ROWS.map(i => (
				<div key={i} className="wkrow" data-day={DOW[i]!.toLowerCase()}>
					<span className="hday">{DOW[i]}</span>
					<Windows label={LONG[i]!} windows={p.week[i]!} off={p.anyHours ? "Off" : "Any hour"}
					         onChange={w => p.onWeek(i, w)} />
				</div>
			))}
			<div className="toolbar" style={{ marginTop: 10 }}>
				<label className="lbl" title="Where the calendar starts its week and the timeline draws its week rules. The scheduler does not read it.">Week starts
					<select id="weekstart" value={p.weekStart} onChange={e => p.onWeekStart(+e.target.value)}>
						{DOW.map((d, i) => <option key={d} value={i}>{d}</option>)}
					</select></label>
			</div>
			<div className="hint" style={{ marginTop: 14 }}>
				Date overrides replace that date's weekday hours; no windows means the day is off. Only today and later are listed.
			</div>
			<div className="toolbar" style={{ marginTop: 6 }}>
				<label className="lbl">Date
					<input type="date" id="hovnew" value={pending} min={p.today}
					       onChange={e => setPending(e.target.value)}
					       onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
				</label>
				<button id="hovadd" onClick={add}>Add override</button>
			</div>
			{p.dates.length
				? p.dates.map(([iso, w]) => (
					<div key={iso} className="wkrow" data-date={iso}>
						<span className="hday hdate">{iso}</span>
						<Windows label={iso} windows={w} off="Off" onChange={n => p.onDate(iso, n)} />
						<button className="hrm hdel" aria-label={`Remove the override for ${iso}`} title="Remove this date override"
						        onClick={() => p.onDate(iso, null)}>×</button>
					</div>
				))
				: <div style={{ marginTop: 8 }}><span className="lbl hoff">No date overrides.</span></div>}
		</div>
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
