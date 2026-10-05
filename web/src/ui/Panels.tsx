// THE SMALL PANELS: the front door's recent plans, the keyring's worked example,
// and the rename-mentions dialog.
import type { Id } from "../types.js";
import { Key, type Swatch } from "./fields.js";

// ---------------------------------------------------------------------------
/** A plan you had open before. THE TOKEN IS NEVER SHOWN — this list is read over
 *  shoulders and shared on screens like everything else on it. */
export interface RecentPlan { tok: string; title: string; ago: string }

export function Recents({ plans, onOpen }: { plans: RecentPlan[]; onOpen: (tok: string) => void }) {
	return <>{plans.map(e => (
		<li key={e.tok}>
			<button className="recent" type="button" onClick={() => onOpen(e.tok)}>
				<b>{e.title}</b><span>{e.ago}</span>
			</button>
		</li>
	))}</>;
}

// ---------------------------------------------------------------------------
/** What a reference turns into, using a REAL one from this plan — so the box
 *  shows the shape in use rather than one this tool made up and implied a tracker
 *  with. */
export function KeyringSample({ base, ref, url }:
                              { base: string; ref: string | null; url: string | null }) {
	if (!base) return <>Nothing to share yet — set a base first.</>;
	if (!ref) return <>No task has a reference yet.</>;
	return <>e.g. {ref} → <code>{url}</code></>;
}

// ---------------------------------------------------------------------------
export interface Mention {
	id: Id;
	/** "name" or "note" — what the old wording is sitting in. */
	where: string;
	/** The text as it stands, split around every occurrence of the old name. */
	parts: string[];
	checked: boolean;
}

export interface MentionsProps {
	oldName: string;
	newName: string;
	mentions: Mention[];
	onToggle: (i: number, on: boolean) => void;
}

/** THE DIFF IS RENDERED, NOT SPLICED. The old text is split on the old name and
 *  the marks go between the pieces, so nothing anybody typed is ever interpolated
 *  into markup — the imperative version had to escape first and then split on the
 *  *escaped* needle to get the same guarantee. */
export function MentionsList(p: MentionsProps) {
	return <>{p.mentions.map((m, i) => (
		<label key={`${m.id}:${m.where}:${i}`}>
			<input type="checkbox" data-m={i} checked={m.checked}
			       onChange={e => p.onToggle(i, e.target.checked)} />
			<span className="where">{m.where}</span>
			<span>{m.parts.map((piece, k) => (
				<span key={k}>
					{k > 0 && <><del>{p.oldName}</del><ins>{p.newName}</ins></>}
					{piece}
				</span>
			))}</span>
		</label>
	))}</>;
}

export function MentionsSub({ newName, count }: { newName: string; count: number }) {
	return (
		<>Renamed to <b>{newName}</b>. {count} mention{count === 1 ? "" : "s"} of the old name
		elsewhere in the plan — untick anything that should keep the old wording.</>
	);
}

// ---------------------------------------------------------------------------
/** THE GRID OF STYLES. One shared popover rather than one per row: there is only
 *  ever one open, and `position:fixed` keeps it clear of the settings card, which
 *  scrolls — the same clip that swallowed the colour picker.
 *
 *  THE NAME SURVIVES AS A TOOLTIP AND NOWHERE ELSE. It is worth having for anyone
 *  describing a plan out loud, and worth keeping out of the way for everyone
 *  choosing one: "backslashdense" and "hatchdense" differ by one letter as words
 *  and obviously as textures. */
export function StylePop({ opts, onPick }:
                         { opts: { v: string; swatch: Swatch; on: boolean }[];
                           onPick: (v: string) => void }) {
	return <>{opts.map(o => (
		<button key={o.v} className={`swopt${o.on ? " on" : ""}`} data-sv={o.v} title={o.v}
		        onClick={() => onPick(o.v)}>
			<Key s={o.swatch} />
		</button>
	))}</>;
}
