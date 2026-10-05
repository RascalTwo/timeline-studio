// HISTORY — every save, newest first, and three things you can do with one.
//
// COMPARE IS A LENS, FORK IS A NEW PLAN, PLAY IS A FILM, AND NONE OF THEM MOVES
// THIS ROOM. That is the whole shape of the panel. Comparing leaves the plan you
// are on exactly where it is and paints that version underneath it; forking copies
// the version out to somewhere the room is not; playback takes this tab out of the
// room and puts it back on exit. Three buttons because they are three different
// questions, and one control that did all of them would have to guess.
import { CommitField } from "./fields.js";

/** One half of a row's "what changed since the save before it". `cls` is `up` for
 *  a later finish and `dn` for an earlier one — later is worse. */
export interface DeltaPart { text: string; cls?: string }

export interface HistoryRow {
	n: number;
	when: string;
	note: string;
	/** "5 tasks". */
	tasks: string;
	/** "lands Dec 14", or "—" when the version cannot be scheduled. */
	lands: string;
	delta: DeltaPart[];
	comparing: boolean;
	/** The newest save — what the plan was last written down as. */
	isNow: boolean;
}

export interface HistoryProps {
	/** `null` while reading. */
	rows: HistoryRow[] | null;
	error: string | null;
	onNote: (n: number, note: string) => void;
	onCompare: (n: number) => void;
	onPlay: (n: number) => void;
	onFork: (n: number) => void;
}

export function History(p: HistoryProps) {
	if (p.error) return <div className="err">{p.error}</div>;
	if (!p.rows) return <div className="hint">reading…</div>;
	return (
		<>{p.rows.map(r => (
			<div key={r.n} className={`hrow${r.isNow ? " now" : ""}`}>
				<b>#{r.n}</b>
				<span className="hwhen">{r.when}</span>
				{/* Commits on blur or Enter, not per keystroke: a note is a sentence
				    somebody is composing, and every character would be a round trip to
				    `/api/histnote`. Escape leaves the field rather than closing the
				    panel out from under someone mid-sentence. */}
				<CommitField className="hnote" data-n={r.n} value={r.note}
				             placeholder="what changed?" commit={v => p.onNote(r.n, v)} />
				<span className="hstat">{r.tasks}</span>
				<span className="hstat">{r.lands}</span>
				<span className="hdelta">
					{r.delta.map((d, i) => (
						<span key={i} className={d.cls}>{i ? " · " : ""}{d.text}</span>
					))}
				</span>
				<button className="hcmp" data-n={r.n} onClick={() => p.onCompare(r.n)}>
					{r.comparing ? "Comparing" : "Compare"}
				</button>
				{/* PLAY FROM HERE, per row, because "what changed after the thing I
				    remember" is the question people actually bring to this panel —
				    starting from #1 every time makes a 65-save plan a chore to get to
				    the interesting part. */}
				<button className="hplay" data-n={r.n} title="Play the plan forward from this save"
				        onClick={() => p.onPlay(r.n)}>▶</button>
				<button className="hfork" data-n={r.n} onClick={() => p.onFork(r.n)}
				        title="Copy this version into a new plan with its own link">Fork</button>
			</div>
		))}</>
	);
}
