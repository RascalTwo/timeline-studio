// THE BACKGROUND OF THE CHART — the day bands, the rules, the flags, and the
// axis that labels them.
//
// ADR 0004 kept this imperative and gave "they are `position:absolute` against
// `#grid`" as the reason, which is not one: React renders absolutely-positioned
// divs like anything else. The honest argument was the other one — these are
// recomputed wholesale on every render, so reconciliation has nothing to
// conserve — and it was never measured. It has been now: a full render of the
// 135-task plan takes about a millisecond, twelve samples inside 5–6ms of a
// 5ms quiet window. There was no headroom being protected.
//
// EVERY NUMBER IS COMPUTED BY `app.ts` AND ARRIVES AS A PIXEL. That is the same
// rule the rest of `ui/` follows and it matters most here: `X()`, `LO`, `PPD` and
// `LABW` are the chart's scale, a component that knew them could disagree with
// the bars, and the bars are the thing this is a backdrop for.
//
// DOM ORDER IS PAINT ORDER. Nothing here carries a `z-index`, so the bands have
// to come before the rules exactly as they did when this was a run of
// `grid.append()` calls — and the host is `display:contents` (`.nobox`), so it
// adds no box and leaves its children as direct participants of `#grid`'s layout
// in the position they already occupied.

/** A run of non-working days. One per RUN rather than one per day: a weekend is
 *  one shape because it reads as one gap, and a holiday touching a weekend is one
 *  longer gap, which is what it feels like to the people in it. */
export interface Band {
	left: number;
	width: number;
}

/** A vertical line: a month, a sprint boundary, today, or a milestone. */
export interface Rule {
	key: string;
	left: number;
	/** Everything after `gl` — `mon`, `spr`, `today`, `deadline ms-late`. */
	cls: string;
	/** Milestone and today lines colour themselves from the verdict. */
	color?: string;
}

/** A label in the axis strip above the grid. */
export interface AxisLabel {
	key: string;
	left: number;
	top: number;
	/** Everything after `ax` — `mon`, `spr`, `flag`. */
	cls: string;
	text: string;
	color?: string;
	/** Milestone labels are right-aligned so a line near the end of the chart
	 *  cannot push its own label off the edge. */
	right?: boolean;
}

export function Furniture({ bands, rules }: { bands: Band[]; rules: Rule[] }) {
	return <>
		{bands.map((b, i) => (
			<div key={i} className="nwd" style={{ left: b.left, width: b.width }} />
		))}
		{rules.map(r => (
			<div key={r.key} className={`gl ${r.cls}`}
			     style={{ left: r.left, ...(r.color ? { background: r.color } : null) }} />
		))}
	</>;
}

// A REAL BLOCK ELEMENT AT THE TOP OF THE FLOW, not labels pinned above the grid
// with a negative `top`. The first version did the latter and they were
// invisible: `#chart` sets `overflow-x:auto`, and per spec a non-visible value on
// one axis computes the other to `auto` too — so `overflow-y` was silently
// scrollable and clipped everything above y=0. Keep the axis in flow.
//
// `.axgut` is the sticky corner that keeps the label column's width reserved
// while the chart scrolls sideways. It is first, and it is not a label.
export function Axis({ labels }: { labels: AxisLabel[] }) {
	return <>
		<div className="axgut" />
		{labels.map(l => (
			<div key={l.key} className={`ax ${l.cls}`}
			     style={{ left: l.left, top: l.top, ...(l.color ? { color: l.color } : null),
			              ...(l.right ? { transform: "translateX(-100%)" } : null) }}>
				{l.text}
			</div>
		))}
	</>;
}
