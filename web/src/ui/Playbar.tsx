// THE PLAYBACK TRANSPORT, and the arc above it.
//
// THE ARC IS THE SECOND ALTITUDE. The chart answers "what did this version look
// like". It cannot answer "was this version better than the one before it",
// because you only ever see one at a time — and that is the question people
// actually open History for. One point per save, height is the forecast finish, so
// three weeks of work reads as a shape rather than as sixty-five charts you have
// to hold in your head.
//
// THE GEOMETRY LIVES HERE, ALL OF IT. It used to be split: `drawArc` laid the
// shape out and stashed its `x()`/`y()` closures on the playback session so that
// `moveArcHead` could move a retained `<circle>` by `setAttribute`, and the click
// handler re-derived the same padding a third time to turn an x back into a save.
// Three copies of one mapping, and the comment on the third said so ("back
// through the same padding the draw used"). Rendering the head as part of the
// picture makes it one copy — and a ten-element SVG redrawn on a 900ms step is
// not a cost worth a cache.
const W = 1000, H = 46, PAD = 5;

export interface PlaybarProps {
	/** Every save, oldest first. */
	versions: { n: number }[];
	/** Forecast finish per save as ABSOLUTE epoch ms, `null` where the version
	 *  will not schedule. Absolute so versions that moved their own start date
	 *  still compare. */
	stats: (number | null)[];
	/** Milestone dates, from the NEWEST save. They belong in the domain, not on
	 *  top of it: a rule drawn outside the range is a line pinned to the edge,
	 *  which reads as "we are exactly on target" when it means "off the chart". */
	targets: { label: string; at: number }[];
	i: number;
	playing: boolean;
	when: string;
	/** `null` renders the "saved without a note" placeholder. */
	note: string | null;
	onExit: () => void;
	onPlayPause: () => void;
	onStep: (n: -1 | 1) => void;
	onSeek: (i: number) => void;
}

export function Playbar(p: PlaybarProps) {
	const last = Math.max(1, p.versions.length - 1);
	const x = (i: number) => PAD + i * (W - PAD * 2) / last;
	const pts = p.stats.map((at, i) => ({ i, at })).filter(q => q.at != null) as { i: number; at: number }[];
	// One usable point cannot make a line, and a plan whose every version holds a
	// dependency cycle is a real thing to land on. Leave the strip empty rather
	// than drawing a shape off one number.
	const drawable = pts.length >= 2;
	const vals = pts.map(q => q.at).concat(p.targets.map(t => t.at));
	const lo = drawable ? Math.min(...vals) : 0;
	const span = (drawable ? Math.max(...vals) : 1) - lo || 1;
	// UP IS LATER. A forecast sliding out to April has to climb: a line that falls
	// as the plan gets worse reads as improvement at a glance, and this strip is
	// read at a glance or not at all.
	const y = (at: number) => (H - PAD) - (at - lo) * (H - PAD * 2) / span;
	const d = pts.map((q, k) => (k ? "L" : "M") + x(q.i) + " " + y(q.at)).join(" ");
	const here = p.stats[p.i];
	const cur = p.versions[p.i];

	return (
		<>
			<button id="pb-exit" title="Leave playback and rejoin the room (Esc)"
			        onClick={p.onExit}>✕ Exit</button>
			<button id="pb-play" title="Play or pause (Space)"
			        onClick={p.onPlayPause}>{p.playing ? "❚❚" : "▶"}</button>
			<button id="pb-prev" title="Previous save (←)" onClick={() => p.onStep(-1)}>◀</button>
			<button id="pb-next" title="Next save (→)" onClick={() => p.onStep(1)}>▶|</button>
			<span id="pb-count">#{cur?.n} · {p.i + 1}/{p.versions.length}</span>
			{/* THE ARC SITS ON THE SCRUBBER'S OWN COLUMN, stacked directly above it,
			    so one x position means one save in both. The range input stays: it is
			    the keyboard-and-assistive-tech way to seek, and the arc is a picture
			    you can also click. */}
			<div id="pb-track">
				<svg id="pb-arc" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
				     role="img" aria-label="Forecast finish date across every save"
				     // CLICK THE SHAPE TO GO THERE. The strip is a picture of the whole
				     // history, so the thing you want after seeing a cliff in it is that
				     // save — reading the x back off the box beats dragging to it.
				     onClick={e => {
				       const r = e.currentTarget.getBoundingClientRect();
				       if (!r.width) return;
				       const u = ((e.clientX - r.left) / r.width * W - PAD) / (W - PAD * 2);
				       p.onSeek(Math.max(0, Math.min(p.versions.length - 1, Math.round(u * last))));
				     }}>
					{drawable && <>
						<path className="arc-fill"
						      d={`${d} L ${x(pts.at(-1)!.i)} ${H} L ${x(pts[0]!.i)} ${H} Z`} />
						<path className="arc-line" d={d} />
						{p.targets.map((t, k) => (
							<line key={t.label + k} className="arc-ms"
							      stroke={k === 0 ? "var(--danger)" : "var(--warn)"}
							      x1={0} x2={W} y1={y(t.at)} y2={y(t.at)}>
								<title>{`${t.label} — target ${new Date(t.at).toISOString().slice(0, 10)}`}</title>
							</line>
						))}
						<line className="arc-now" x1={x(p.i)} x2={x(p.i)} y1={0} y2={H} />
						{/* A version that will not schedule has no height to sit at. Hide the
						    dot rather than parking it at zero, which would draw a point the
						    data does not have; the rule still shows which save you are on. */}
						<circle className="arc-head" r={3.4} cx={x(p.i)}
						        cy={here == null ? 0 : y(here)} opacity={here == null ? 0 : 1} />
					</>}
				</svg>
				<input type="range" id="pb-scrub" min={0} max={p.versions.length - 1} value={p.i}
				       aria-label="Saved version"
				       onChange={e => p.onSeek(+e.target.value)} />
			</div>
			<span id="pb-when">{p.when}</span>
			<div id="pb-note">{p.note ?? <em>saved without a note</em>}</div>
		</>
	);
}
