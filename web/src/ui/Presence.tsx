// WHO ELSE IS HERE — the roster strip and the pointers on the chart.
//
// BOTH HALVES TOGETHER, because both answer the same question and a strip that
// disagrees with the cursors is worse than either alone.
export interface WhoChip {
	name: string;
	color: string;
	/** Yours. Drawn LOCALLY, never from the roster, so it is still here while
	 *  lurking — and it has to be, or the one state you can forget you are in is
	 *  the one with no indicator. */
	mine: boolean;
	lurking: boolean;
	title: string;
}

export function Who({ chips, onRename }: { chips: WhoChip[]; onRename: () => void }) {
	return <>{chips.map((c, i) => (
		<span key={c.mine ? "me" : `${i}:${c.name}`}
		      className={`whochip${c.mine ? " me" : ""}${c.mine && c.lurking ? " lurking" : ""}`}
		      title={c.title} onClick={c.mine ? onRename : undefined}>
			{/* Set as a style value rather than interpolated into an attribute string:
			    a peer's colour is 32 unverified characters off the wire, and the
			    browser drops what it cannot parse instead of letting it become CSS of
			    its own. */}
			<i style={{ background: c.color }} /><b>{c.name}</b>
		</span>
	))}</>;
}

export interface Cursor {
	key: string;
	name: string;
	color: string;
	/** Already converted to OUR pixels — see the note at the call site. */
	left: number;
	top: number;
}

export function Cursors({ cursors }: { cursors: Cursor[] }) {
	return <>{cursors.map(c => (
		<div key={c.key} className="pcur" style={{ left: c.left, top: c.top }}>
			<svg width="15" height="19" viewBox="0 0 15 19" aria-hidden="true">
				<path d="M1 1 L1 15.5 L4.8 11.9 L7.3 17.6 L10.1 16.4 L7.6 10.9 L12.8 10.8 Z"
				      fill={c.color} stroke="#0b0f14" strokeWidth={1.1} strokeLinejoin="round" />
			</svg>
			<b style={{ background: c.color }}>{c.name}</b>
		</div>
	))}</>;
}
