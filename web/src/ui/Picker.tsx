// A DROPDOWN WHOSE OPTIONS COME FROM THE DOCUMENT.
//
// Six `<select>`s were the last region assembling `<option>` markup as a string.
// ADR 0004 recorded them as a deliberate exception on the grounds that "React
// would own their `<option>`s while the markup owned the element the change fires
// on" — which is an argument against doing it HALFWAY, not against doing it. This
// owns the whole control, so there is no split to keep straight, and `value` is a
// prop rather than a property assigned after the options were replaced.
//
// THE HOST SPAN IS `display:contents` — see `.pickhost` in styles.css. React
// needs a container it can own, and that one generates no box at all, so each
// select sits inside its `<label class="lbl">` in exactly the layout it had when
// it was written there by hand. It is the cheapest way to add a container without
// adding a box.
//
// `disabled` is deliberately NOT a prop. The "could not open that plan" path
// disables a list of controls imperatively, and React leaves alone any attribute
// it was never given — so that mechanism keeps working untouched.
//
// One thing got deleted on the way in. `syncZoomPicker` carried a hand-built
// rebuild key, "so a render that changes nothing does not rebuild the list
// underneath an open dropdown". That is what reconciliation is.
export interface PickerOption {
	value: string;
	label: string;
}

export interface PickerProps {
	id: string;
	/** Must be one of `options`, or the browser picks the first and the control
	 *  disagrees with the state behind it. Every caller derives it from the same
	 *  place it derives the list. */
	value: string;
	options: PickerOption[];
	onPick: (value: string) => void;
}

export function Picker({ id, value, options, onPick }: PickerProps) {
	return (
		<select id={id} value={value} onChange={e => onPick(e.target.value)}>
			{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
		</select>
	);
}
