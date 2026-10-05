// THE DEPENDENCY ARROWS.
//
// The last region assembling markup as a string, and the only one where the
// string was SVG. ADR 0004 said it "relies on SVG document order for stacking",
// which is true and is not a reason: a list rendered in order is still in order.
// React reconciles into the `<svg>` container the same way it reconciles into a
// `<div>`, and the elements keep the order they are given.
//
// PINS ARE PAINTED LAST, so they cannot be overdrawn. SVG has no `z-index` —
// document order IS stacking order — and edges are emitted in task order, so a
// wide pinning line pushed early was being partly covered by ordinary ones
// crossing it. The one line the eye is meant to find was the one most likely to
// be underneath. `app.ts` hands them over already in that order.
//
// THE SVG'S OWN SIZE STAYS IMPERATIVE, and deliberately. `drawArrows` sets it
// from `#grid.offsetWidth` on its first line, which is what makes the size the
// TELL that the function ran at all: an svg still at its 300x150 default means it
// never ran, and one matching the grid with no paths means it ran and found
// nothing. That is a property of the container, and containers are `app.ts`'s.
export interface Arrow {
	key: string;
	/** The path itself, in the chart's pixels — computed by `app.ts` from the
	 *  same `X()` and row offsets the bars are drawn at. */
	d: string;
	stroke: string;
	width: number;
	/** Hue is the DIRECTION, the dash is the DISTANCE: solid is one hop, dashed
	 *  is the rest of that chain. */
	dash: boolean;
	opacity: number;
	/** The one dependency actually holding this task's start — the term of the
	 *  scheduler's `Math.max` that won. */
	pin: boolean;
}

export function Arrows({ arrows }: { arrows: Arrow[] }) {
	return <>{arrows.map(a => (
		<path key={a.key} d={a.d} fill="none" stroke={a.stroke} strokeWidth={a.width}
		      strokeDasharray={a.dash ? "5 4" : "none"} opacity={a.opacity}
		      {...(a.pin ? { "data-pin": "1" } : null)} />
	))}</>;
}
