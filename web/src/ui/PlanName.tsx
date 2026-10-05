// THE PLAN'S NAME, in the popover behind ✎.
//
// The last holder of `emit(cmd, keep)`. That parameter threaded a SELECTOR through
// the command layer so the caret could be put back after a render, and this field
// needed it for a subtler reason than the panels did: `#title` is a stable element
// that was never rebuilt, but `renderInner` assigned `.value` on every render, and
// assigning a DIFFERENT string to a focused input moves the caret to the end. So
// typing a plan name jumped to the end after every character.
//
// Controlled, the assignment only happens when the document actually differs from
// what is in the box — which, mid-keystroke, it does not.
export interface PlanNameProps {
	value: string;
	onChange: (v: string) => void;
	/** Enter and Escape both close the popover. Neither discards: every keystroke
	 *  has already been sent, so there is nothing to take back — closing is just
	 *  putting the lid on. */
	onDone: () => void;
}

export function PlanName(p: PlanNameProps) {
	return (
		<label className="lbl">Plan name
			<input type="text" id="title" placeholder="plan name" style={{ minWidth: 260 }}
			       value={p.value}
			       onChange={e => p.onChange(e.target.value)}
			       onKeyDown={e => {
			         if (e.key === "Enter" || e.key === "Escape") { p.onDone(); e.stopPropagation(); }
			       }} />
		</label>
	);
}
