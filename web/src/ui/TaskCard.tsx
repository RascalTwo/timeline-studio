// A TASK, READ-ONLY, from the Inspector's own view model. The Rank tab asks "which
// should happen first?" about two tasks at a time, and the honest way to answer is with
// everything you would read about each one anyway — so each side of the question is this
// card, built from `inspectorTaskOf` in app.ts: the same content the Inspector shows,
// computed once, so the two cannot disagree. It is its own small view rather than the
// Inspector mounted twice because the Inspector is a set of live controls with fixed ids
// (`#lab`, `#comments`…) that the page looks up; two more copies would answer those
// lookups instead of it.
//
// INLINE STYLES, ON PURPOSE. It renders inside <pairwise-compare>'s shadow root, which
// the page's stylesheet cannot reach — so it carries its own look, in the page's tokens
// (custom properties DO inherit through a shadow boundary).
import type { CSSProperties } from "react";
import type { InspectorTask } from "./Inspector.js";

const S: Record<string, CSSProperties> = {
	card: { display: "flex", flexDirection: "column", gap: 8, width: "100%", fontSize: 13, textAlign: "left", color: "var(--text)" },
	title: { fontSize: 17, fontWeight: 600, overflowWrap: "anywhere" },
	facts: { display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", gap: "2px 12px" },
	k: { color: "var(--muted)" },
	v: { overflowWrap: "anywhere" },
	desc: { maxHeight: 220, overflow: "auto", borderTop: "1px solid var(--line)", paddingTop: 6, lineHeight: 1.45 },
	none: { color: "var(--muted)" },
	summary: { cursor: "pointer", color: "var(--muted)" },
	comment: { borderTop: "1px solid var(--line)", paddingTop: 4, marginTop: 4 },
};

export function TaskCard({ task: t }: { task: InspectorTask }) {
	const fact = (k: string, v: string | null | undefined) =>
		v ? <><span style={S.k}>{k}</span><span style={S.v}>{v}</span></> : null;
	return (
		<div className="taskcard" data-taskcard={t.id} style={S.card}>
			<div style={S.title}>{t.label}</div>
			<div style={S.facts}>
				{fact("Duration", t.dur)}
				{fact("Scheduled", `${t.startsText} → ${t.endsText}`)}
				{fact("Due", t.due && `${t.due.replace("T", " ")}${t.dueSlack ? ` · ${t.dueSlack.text}` : ""}`)}
				{fact("Not before", t.notBefore && t.notBefore.replace("T", " "))}
				{fact(t.labels.colors, t.colorSummary !== "—" ? t.colorSummary : null)}
				{fact("Link", t.url || t.ref || null)}
				{fact("Waits on", t.deps.map(c => c.label).join(", ") || null)}
				{fact("Unblocks", t.blocks.map(c => c.label).join(", ") || null)}
			</div>
			{t.desc
				? <div className="mdview" style={S.desc} dangerouslySetInnerHTML={{ __html: t.descHtml }} />
				: <div style={{ ...S.desc, ...S.none }}>No description.</div>}
			{t.comments.length > 0 && (
				<details>
					<summary style={S.summary}>Comments · {t.comments.length}</summary>
					{t.comments.map(c => (
						<div key={c.id} style={S.comment}>
							<div><b>{c.by}</b> <span style={S.k}>{c.when}</span></div>
							<div className="mdview" dangerouslySetInnerHTML={{ __html: c.html }} />
						</div>
					))}
				</details>
			)}
		</div>
	);
}
