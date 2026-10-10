// THE LEGEND — a key and a filter, and the third region React draws.
//
// It owns the last of `applyFilter()`'s hand-poking: that function reached into
// `#legend` and toggled `.on` on every `[data-fv]` element, because rebuilding the
// legend on a pointer move across it was not affordable when a rebuild meant
// `innerHTML =`. Reconciling a few dozen chips is.
//
// PRESENTATION ONLY, same contract as the other two: every count, every label and
// every swatch is computed in `app.ts` beside the channel helpers the chart uses,
// so the legend cannot drift from the bars. That is the one place a hand-kept
// legend always goes wrong.
import type { Id } from "../types.js";
import { Key, type Swatch } from "./fields.js";

export type { Swatch };

export interface LegendItem {
	id: Id;
	label: string;
	swatch: Swatch;
	count: number;
	/** Total duration, shown only when `effort` is on. Always in the title. */
	effort: string;
	on: boolean;
}

export interface LegendGroup {
	key: string;
	title: string;
	/** Marks the heading with a `*` and explains itself on hover. */
	note?: string;
	items: LegendItem[];
}

export interface LegendProps {
	groups: LegendGroup[];
	isolate: boolean;
	effort: boolean;
	showDone: boolean;
	clear: { shown: boolean; label: string };
	onPick: (channel: string, id: Id) => void;
	onPreview: (channel: string, id: Id) => void;
	onPreviewEnd: () => void;
	/** False once isolate is actually hiding rows — see the note at the call site. */
	canPreview: () => boolean;
	onIsolate: (v: boolean) => void;
	onEffort: (v: boolean) => void;
	onShowDone: (v: boolean) => void;
	onClear: () => void;
}

export function Legend(p: LegendProps) {
	return (
		<>
			{/* A CHANNEL WITH FEWER THAN TWO VALUES CARRIES NO INFORMATION, so it shows
			    no UI — the caller filters those out before they get here. A legend
			    entry you can click to isolate 100% of the chart is a control that
			    cannot do anything, and a filter that cannot narrow reads as broken
			    rather than as complete. */}
			{p.groups.map(g => (
				<span key={g.key} className={`grp g-${g.key}`}>
					<b title={g.note}>{g.title}{g.note && <span className="lgc">*</span>}</b>
					{g.items.map(it => (
						<button key={it.id} className={`it${it.on ? " on" : ""}${it.count ? "" : " zero"}`} data-fv={`${g.key}|${it.id}`}
						        title="Click to focus · click again to widen"
						        // Hover previews just this value — a fast "what is this?" that
						        // ignores any filter already set, so it answers the question
						        // actually asked. Bound on BOTH pointer and mouse events:
						        // pointer alone is the modern choice but leaves anything that
						        // only emits mouse events — some automation, some assistive
						        // tooling, older Safari — with no preview at all, and the
						        // preview is what makes this discoverable.
						        onPointerEnter={() => p.canPreview() && p.onPreview(g.key, it.id)}
						        onMouseEnter={() => p.canPreview() && p.onPreview(g.key, it.id)}
						        onPointerLeave={() => p.canPreview() && p.onPreviewEnd()}
						        onMouseLeave={() => p.canPreview() && p.onPreviewEnd()}
						        onClick={() => p.onPick(g.key, it.id)}>
							<Key s={it.swatch} />
							{it.label}
							{/* THE COUNT STAYS ON THE FACE, THE EFFORT IS OPT-IN. The title has
							    said both all along, and `54·219 days` beside `54 tasks, 219 days
							    of work` is the same number twice at twice the width — which across
							    six channels was ~44% of the legend's text, competing with the
							    chart for the screen. Nothing is hidden that a hover does not
							    give back. */}
							{/* "in view", because that is what the number IS: `stat()` in app.ts
							    counts what the other filters and the done gate let through. The
							    words are what tell a reader the chip is not a plan-wide total. */}
							<span className="lgc" title={`${it.count} task${it.count === 1 ? "" : "s"} in view, ${it.effort} of work`}>
								{it.count}{p.effort ? `·${it.effort}` : ""}
							</span>
						</button>
					))}
				</span>
			))}
			{/* THESE ARE NOT FILTERS AND THEY WERE SITTING IN A ROW OF FILTERS.
			    A chip narrows the chart to a value; these four decide how what is
			    left gets DRAWN. The confusion was concrete rather than theoretical:
			    a Cancelled chip and a `cancelled` switch, inches apart, looked like
			    the same control twice — and since picking the chip started forcing
			    the drawing, the chip does the switch's job plus filtering, which
			    made them read as redundant when they are not. So they get a card
			    and a heading, the way every other cluster on this bar does, and
			    the heading is the whole explanation. */}
			<span className="grp g-view">
			<b title="How the chart is drawn, as against which tasks it draws. Nothing here narrows the plan — the chips above do that.">View</b>
			{/* NAMED FOR THE LENS, NOT FOR ITS SIDE EFFECT. This read "hide the
			    rest", which described what happens to the rows you did not pick
			    rather than what the control is — unsayable, unreferenceable, and
			    the one label in the app that disagreed with the source, where it
			    has been `focusMode = "dim" | "isolate"` all along. */}
			<label className="lbl fmode"
			       title="Dim: keep every row, grey the rest. Isolate: show only what you picked. Shortcut: I.">
				<input type="checkbox" id="isolate" checked={p.isolate}
				       onChange={e => p.onIsolate(e.target.checked)} /> isolate
			</label>
			<label className="lbl fmode"
			       title="Add the duration still to do beside each value's count. Off by default — it roughly doubles the width of every chip, and the same number is in each chip's tooltip.">
				<input type="checkbox" id="showeffort" checked={p.effort}
				       onChange={e => p.onEffort(e.target.checked)} /> effort
			</label>
			<label className="lbl fmode"
			       title="Draw work that is finished. Off by default: a plan you have been running for a while is mostly things you already did, and they cannot be acted on. The tasks are still in the plan either way.">
				<input type="checkbox" id="showdone" checked={p.showDone}
				       onChange={e => p.onShowDone(e.target.checked)} /> done
			</label>
			</span>
			{/* The button clears what is FILTERED. C goes one further and puts the
			    three toggles above back too, which is worth saying here because this
			    is the only place either of them is written down. */}
			<button id="clearfilter" hidden={!p.clear.shown} onClick={p.onClear}
			        title="Clear the chips, the search box and the chain focus. Shortcut: C, which also resets done, effort and isolate.">{p.clear.label}</button>
		</>
	);
}
