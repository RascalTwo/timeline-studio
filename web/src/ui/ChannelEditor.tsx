// SETTINGS → CHANNELS. All four channels at once, and the last panel on the
// render path that was built with `innerHTML`.
//
// It held THREE of the four `emit(cmd, keep)` call sites in the page — the channel
// name, each value's name, and a lane's short name are all `oninput` text fields,
// so every keystroke rebuilt the whole panel and needed the caret put back by
// hand. All three are ordinary controlled inputs now.
//
// ONE ROW PER VALUE, ONE GRID PER CHANNEL, and every channel uses the SAME four
// columns — name / style / used / controls — so the eye can run straight down a
// column even across channels whose middle control is a colour swatch in one and a
// style picker in the next. The style column is fixed-width for exactly that
// reason; letting it size to content is what broke the alignment before.
import type { Id } from "../types.js";
import { CommitField, ColorField, Key, type Swatch } from "./fields.js";

/** What sits in the "style" column. A lane has no style — it is a row group — so
 *  it spends the column on the two things a lane does have. */
export type ValueControl =
	| { kind: "lane"; cap: number; short: string; shortPlaceholder: string }
	| { kind: "color"; color: string }
	| { kind: "style"; swatch: Swatch }
	| { kind: "none" };

export interface ChannelValueRow {
	id: Id;
	label: string;
	/** How many tasks use this value. */
	used: number;
	isDefault: boolean;
	control: ValueControl;
}

export interface ChannelBlock {
	key: string;
	/** What this plan calls the channel — editable, and the legend follows it. */
	label: string;
	/** "drawn as bar colour", from the fixed vocabulary rather than the plan's. */
	drawnAs: string;
	/** Only some channels have a not-applicable value worth designating. */
	canDefault: boolean;
	/** Wording for the default toggle's title, which names the channel. */
	defaultNoun: string;
	values: ChannelValueRow[];
	/** colors only: the hex a task with an empty list is drawn in. */
	noColor?: string;
	/** lanes only. */
	canSort?: boolean;
}

export interface ChannelEditorProps {
	channels: ChannelBlock[];
	onChannelLabel: (key: string, v: string) => void;
	onValueLabel: (key: string, i: number, v: string) => void;
	onCap: (i: number, v: string) => void;
	onShort: (i: number, v: string) => void;
	onColor: (i: number, v: string) => void;
	/** The style grid is a shared body-level popover, positioned against the button
	 *  that opened it — so the element goes with the channel and the index rather
	 *  than being parsed back out of a `data-` string on the way in. */
	onStyle: (key: string, i: number, btn: HTMLElement) => void;
	onDefault: (key: string, i: number) => void;
	onMove: (key: string, i: number, dir: -1 | 1) => void;
	onRemove: (key: string, i: number) => void;
	onAdd: (key: string) => void;
	onSortLanes: () => void;
	onNoColor: (v: string) => void;
}

function Control({ c, i, k, p }:
                 { c: ValueControl; i: number; k: string; p: ChannelEditorProps }) {
	if (c.kind === "lane") return (
		<>
			<label className="cap" title="How many of these can run at once">
				<CommitField type="number" data-cap={i} min="1" step="1" value={c.cap}
				             commit={v => p.onCap(i, v)} />
				<span>at once</span>
			</label>
			<label className="cap" title="What this team is called when it has to fit in a row label, in Rows: Date. Blank uses the full name.">
				{/* BLANK REMOVES THE KEY rather than storing "", so a cleared box means
				    "use the label" in the document as well as on screen. */}
				<input type="text" data-short={i} size={5} style={{ width: 64 }}
				       value={c.short} placeholder={c.shortPlaceholder}
				       onChange={e => p.onShort(i, e.target.value)} />
				<span>short</span>
			</label>
		</>
	);
	if (c.kind === "color") return <ColorField data-c={i} value={c.color} commit={v => p.onColor(i, v)} />;
	if (c.kind === "style") return (
		// PICK THE PICTURE, NOT THE WORD. These were native <select>s of names, and a
		// name is not what you are choosing: "backslashdense" and "hatchdense" differ
		// by one letter as words and obviously as textures, so reading the list told
		// you nothing you wanted to know. Adding a preview beside the dropdown fixed
		// "what did I just pick" and left "what am I picking" unanswered — you still
		// had to choose blind and then look. So the control IS the swatch: it shows
		// the current style and opens a grid of styles to click. Colour never had
		// this problem, because its control has always been its preview.
		<button className="stylebtn" title="Pick a style"
		        onClick={e => { e.stopPropagation(); p.onStyle(k, i, e.currentTarget); }}>
			<Key s={c.swatch} /><i>▾</i>
		</button>
	);
	return null;
}

export function ChannelEditor(p: ChannelEditorProps) {
	return (
		<>{p.channels.map(ch => (
			<div key={ch.key} className="chrow" id={`ch-${ch.key}`}>
				<div className="chhead">
					<input className="chname" data-chname={ch.key} value={ch.label}
					       title="What this plan calls this channel — the legend and the inspector follow it"
					       onChange={e => p.onChannelLabel(ch.key, e.target.value)} />
					<span className="chwhat">drawn as {ch.drawnAs}</span>
					{ch.noColor !== undefined && (
						<label className="nocol"
						       title="A task can genuinely touch no system, so this channel says 'none' with an empty list rather than with a value. This is what that looks like.">
							no system <ColorField id="nocolor" value={ch.noColor} commit={p.onNoColor} />
						</label>
					)}
					{/* ONE BUTTON, AND THE ARROWS STAY. Manual order is the point of the
					    up/downs below and this never overrides them silently — it is a
					    thing you ask for, it says what it changed, and History has the
					    order you had. */}
					{ch.canSort && (
						<button id="sortlanes" className="addch" onClick={p.onSortLanes}
						        title="Put each team above the teams that wait on it, as far as the dependencies allow">
							Sort by dependencies
						</button>
					)}
					<button data-addch={ch.key} className="addch" onClick={() => p.onAdd(ch.key)}>+ Add</button>
				</div>
				<div className="chgrid">
					<div className="chit chhdr"><span>value</span><span>style</span><span>used</span><span></span></div>
					{ch.values.length ? ch.values.map((v, i) => (
						<div key={v.id} className="chit">
							<input className="cl" data-i={`${ch.key}:${i}`} value={v.label} placeholder="name"
							       onChange={e => p.onValueLabel(ch.key, i, e.target.value)} />
							<span className="cst"><Control c={v.control} i={i} k={ch.key} p={p} /></span>
							<span className="use" title="tasks using this">{v.used}</span>
							<span className="btns">
								{/* THE NOT-APPLICABLE VALUE, set here rather than only by a
								    migration. It was invisible state — the plan had one,
								    nothing showed which, and adding a value meant relabelling
								    an old one to move the designation. */}
								{ch.canDefault && (
									<button data-def={`${ch.key}:${i}`} className={`dflt${v.isDefault ? " on" : ""}`}
									        title={v.isDefault
									          ? `This is what a task with no ${ch.defaultNoun} gets. Click to have none.`
									          : `Use this as the value a task with no ${ch.defaultNoun} gets`}
									        onClick={() => p.onDefault(ch.key, i)}>{v.isDefault ? "●" : "○"}</button>
								)}
								<button data-mv={`${ch.key}:${i}:-1`} title="Move earlier" disabled={i === 0}
								        onClick={() => p.onMove(ch.key, i, -1)}>↑</button>
								<button data-mv={`${ch.key}:${i}:1`} title="Move later"
								        disabled={i === ch.values.length - 1}
								        onClick={() => p.onMove(ch.key, i, 1)}>↓</button>
								<button data-x={`${ch.key}:${i}`} title="Remove" className="rm"
								        onClick={() => p.onRemove(ch.key, i)}>×</button>
							</span>
						</div>
					)) : <div className="chit chempty">no values yet</div>}
				</div>
			</div>
		))}</>
	);
}
