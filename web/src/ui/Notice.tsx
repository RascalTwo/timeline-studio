// THE NOTICE: the plan's free text, pinned above the chart (`doc.notice`).
//
// Hiding it is per browser, not per plan: one reader collapsing it must not take it
// away from everyone else. What is remembered is the TEXT that was hidden, so a
// change to the notice shows it again. Hiding something means "I've read this",
// and a new notice hasn't been read.

import { useState } from "react";

export interface NoticeProps {
	text: string;
	/** `text` as sanitised HTML (the same renderer as comments). */
	html: string;
	/** Where the hidden text is remembered: one key per plan. */
	storeKey: string;
	onEdit: () => void;
}

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => {
	try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
};

export function Notice(p: NoticeProps) {
	// Re-read on every render: the stored value is compared with whatever the text is NOW.
	const [, bump] = useState(0);
	if (!p.text) return null;
	const hidden = read(p.storeKey) === p.text;
	const set = (v: string | null) => { write(p.storeKey, v); bump(n => n + 1); };
	return hidden ? (
		<button className="notice-chip" onClick={() => set(null)} title="Show the plan's notice">📌 Notice</button>
	) : (
		<div className="notice-strip">
			<span className="notice-pin">📌</span>
			{/* Sanitised by DOMPurify in `mdHtml`, the same path task comments take. */}
			<div className="notice-text" dangerouslySetInnerHTML={{ __html: p.html }} />
			<button onClick={p.onEdit} title="Edit the notice (Settings → Plan)">✎</button>
			<button onClick={() => set(p.text)} title="Hide until it changes (this browser only)">×</button>
		</div>
	);
}

export interface NoticeEditorProps {
	value: string;
	/** `null` when emptied, which removes the notice. */
	onChange: (v: string | null) => void;
	max: number;
}

// CONTROLLED, like PlanName, so a render mid-keystroke cannot move the caret.
export function NoticeEditor(p: NoticeEditorProps) {
	return (
		<label className="lbl notice-edit">Notice
			<textarea id="noticeedit" rows={3} maxLength={p.max} value={p.value}
			          placeholder="Shown above the chart to everyone with the link. Markdown works."
			          onChange={e => p.onChange(e.target.value || null)} />
			<span className="hint">{p.value.length} / {p.max}</span>
		</label>
	);
}
