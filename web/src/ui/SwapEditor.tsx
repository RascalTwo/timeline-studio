// SETTINGS → SWAP. "These labels are moving there, and this is what they will look
// like" is the entire job of this panel, so it is two columns — one per direction —
// and every warning on it is about something you are about to LOSE.
//
// The last panel on the render path that was built with `innerHTML`.
import { ColorField } from "./fields.js";
import type { Id } from "../types.js";

/** What a value will be drawn as after the swap. `own` is the lane case: a lane is
 *  a row group, so there is no style to pick — it gets its own row. */
export type SwapControl =
	| { kind: "color"; value: string }
	| { kind: "pick"; value: string; opts: string[] }
	| { kind: "own" };

export interface SwapRow {
	id: Id;
	label: string;
	control: SwapControl;
}

export type WarnPart = string | { b: string };

export interface SwapColumn {
	from: string;
	/** "Env → Accuracy". */
	heading: string;
	rows: SwapRow[];
	/** Shown instead of the rows when the source channel has no values. */
	empty: string | null;
	/** Everything you are about to lose, in the order it matters.
	 *
	 *  A LIST OF PARTS, not a node and not a string. `app.ts` builds this and
	 *  `app.ts` is plain TypeScript — it cannot hold JSX, which is the point of the
	 *  seam — but the warning that matters most names the styles two values will
	 *  collide on, and those want emphasis. So the emphasis travels as data. */
	warnings: { key: string; parts: WarnPart[] }[];
}

export interface SwapEditorProps {
	/** Null when both dropdowns name the same channel. */
	columns: [SwapColumn, SwapColumn] | null;
	onPick: (from: string, id: Id, value: string) => void;
}

export function SwapEditor(p: SwapEditorProps) {
	if (!p.columns) return <div className="hint">Pick two different channels.</div>;
	return (
		<div className="swapgrid">
			{p.columns.map(col => (
				<div key={col.from} className="swapcol">
					<b>{col.heading}</b>
					{col.empty
						? <div className="hint">{col.empty}</div>
						: col.rows.map(r => (
							<div key={r.id} className="swaprow">
								<span className="lb">{r.label}</span><span>→</span>
								{r.control.kind === "color"
									? <ColorField data-sw={`${col.from}|${r.id}`} value={r.control.value}
									              commit={v => p.onPick(col.from, r.id, v)} />
									: r.control.kind === "pick"
									? <select data-sw={`${col.from}|${r.id}`} value={r.control.value}
									          onChange={e => p.onPick(col.from, r.id, e.target.value)}>
											{r.control.opts.map(o => <option key={o} value={o}>{o}</option>)}
										</select>
									: <span className="hint">its own row</span>}
							</div>
						))}
					{col.warnings.map(w => (
						<div key={w.key} className="swapwarn">
							{w.parts.map((x, i) => typeof x === "string" ? x : <b key={i}>{x.b}</b>)}
						</div>
					))}
				</div>
			))}
		</div>
	);
}
