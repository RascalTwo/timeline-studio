// THE ONE-SHOT BANNERS — the four ways this page says "something upstream is
// wrong and I cannot answer the question you opened me to answer", plus the two
// that report on something that went right.
//
// They were the last region left building HTML by hand, and the reason recorded
// for it — "written once into `document.body` and replaced wholesale, so there is
// no state to reconcile" — was a statement about what React would BUY here, not
// about what it could do. It buys one thing, and it is the reason this file
// exists: every one of these interpolated a value into an HTML string, so every
// one of them needed `esc()` at each interpolation and was one forgotten call
// away from a plan's title or a scheduler's error message becoming markup. Two of
// them carry a share TOKEN. There is no `esc()` below because there is nothing to
// escape: a JSX expression is text.
//
// The HOST NODE is still `app.ts`'s, created on demand and prepended to the body
// — same division as `#cursors`. React owns containers; making one is not
// rendering.

/** The plan holds a dependency cycle, so there are no dates to draw. */
export function SchedulerDown({ msg }: { msg: string }) {
	return <>
		<b className="err">This plan cannot be scheduled</b><br />{msg}<br />
		<span style={{ color: "var(--muted)" }}>
			The chart is blank because there are no dates to compute — not because the
			plan is empty. Remove the dependency that closes the loop; History →
			Compare shows what changed.
		</span>
	</>;
}

/** The service parks itself at zero and takes about a minute to come back. Two
 *  states rather than two components: the second one is up for 2.5 seconds while
 *  the load balancer notices, and splitting it would be two containers for one
 *  sentence. */
export function WakeSplash({ up, secs, pct }: { up: boolean; secs: number; pct: number }) {
	if (up) return <b>Server is up — loading your plan…</b>;
	return <>
		<b>Waking the server…</b><br />
		<span style={{ color: "var(--muted)" }}>
			This plan is fine. The server parks itself when nobody is using it, and
			takes about a minute to come back. Waiting {secs}s.
		</span>
		<div style={{ marginTop: 8, height: 6, borderRadius: 3,
		              background: "var(--panel)", overflow: "hidden" }}>
			<div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)",
			              transition: "width .6s linear" }} />
		</div>
	</>;
}

export interface ImportedPlan { id: string; shareToken: string }

/** THE ONLY TIME THESE LINKS ARE EVER SHOWN. Each token is a capability and
 *  nothing lists plans, so a reader who closes this tab without copying them has
 *  made plans nobody can reach. */
export function ImportSummary({ made, skipped, base }:
                              { made: ImportedPlan[]; skipped: number; base: string }) {
	return <>
		<b>Imported {made.length} plans</b> — each one is a NEW plan with its own link,
		and these links are the only way back to them. Copy them somewhere before you
		close this.<br />
		{made.map(m => (
			<div key={m.shareToken} style={{ marginTop: 6 }}>
				<a href={`#${m.shareToken}`}>{m.id}</a>{" "}
				<code style={{ userSelect: "all" }}>{base}#{m.shareToken}</code>
			</div>
		))}
		{skipped ? <div style={{ marginTop: 8 }}>Skipped {skipped}.</div> : null}
	</>;
}

/** The scheduler self-test, which runs on every load against a hand-computed
 *  plan. A failure here means the tool is wrong, not the plan. */
export function SelfTestFailed({ bad }: { bad: string[] }) {
	return <>
		<b className="err">Scheduler check failed</b><br />
		{bad.map((b, i) => <span key={i}>{b}<br /></span>)}
	</>;
}

/** A named plan did not load, and the fixture must NEVER be substituted for it —
 *  a plausible wrong chart in a meeting is the worst failure this tool has.
 *
 *  `said` IS THE SERVER'S OWN SENTENCE, and the reason it is threaded through
 *  here at all: when the plan store was unreachable on 2026-09-20 this panel told
 *  the reader their token might have been revoked, so they went looking at their
 *  link while the actual problem was a stopped container. The guesses below are
 *  only worth printing when the server did not say. This is NOT the 404-vs-503
 *  branch the boot path rules out — that rule is about never substituting the
 *  fixture, and nothing here changes what gets rendered. */
export function PlanUnopenable({ wanted, said }: { wanted: string; said?: string }) {
	return <>
		<b className="err">Could not open {wanted}</b><br />
		{said
			? <>The server said: <b>{said}</b>. That is the server's own answer, not a guess
			   from this page — if it names the plan store, your link is fine and there is
			   nothing to fix at this end.{" "}</>
			: <>The plan could not be loaded. If the server was asleep it may still be waking —
			   reload in a moment. Otherwise the link's token may be wrong or have been revoked,
			   in which case reloading will not help and you need a fresh link.{" "}</>}
		<b>Nothing below is this plan</b>, so do not read a chart off it.
	</>;
}

/** The graph lens fetches its library from the network the first time it opens. */
export function GraphUnavailable() {
	return <div id="cyfail">
		The graph library could not be loaded, so this lens is unavailable — the
		timeline is unaffected and every date on it is still right. It is fetched from
		the network the first time this view is opened; switch back to <b>Timeline</b>,
		or reload with a connection.
	</div>;
}
