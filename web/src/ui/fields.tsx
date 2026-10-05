// THE THREE CONTROLS EVERY PANEL NEEDS, in one place because they each encode a
// decision the page made once and must not re-litigate per panel.
import { useRef, useState } from "react";
import type { CSSProperties, InputHTMLAttributes, Ref } from "react";
import { useNativeChange } from "./native.js";

/** How a channel value is drawn. `hidden` is a real case rather than an absence:
 *  a lane is a row heading and "ready" is a fact about the schedule, so drawing a
 *  key for either would invent a mark the chart does not use — but the empty span
 *  still has to be there to keep the chips aligned. */
export interface Swatch {
	hidden?: boolean;
	cls?: string;
	style?: CSSProperties;
	/** The bar silhouettes, which are a nested element rather than a background. */
	shape?: string;
}

/** ONE PLACE KNOWS WHAT "rails" LOOKS LIKE. The caller builds the `Swatch`
 *  through the same `rimCss`/`pat-`/`sh-` vocabulary the bars go through, so the
 *  legend, the channel editor and the chart cannot disagree. */
export function Key({ s }: { s: Swatch }) {
	if (s.hidden) return <span className="k" style={{ background: "none", border: 0, width: 0 }} />;
	if (s.shape) return <span className="shk"><i className={`shape sh-${s.shape}`} /></span>;
	return <span className={`k${s.cls ? " " + s.cls : ""}`} style={s.style} />;
}

/** A field committed on blur or Enter — native `change`, which is NOT what React's
 *  `onChange` means (see `native.ts`). Re-seeds when the document's value changes
 *  underneath it, so another person's edit still lands here. */
export function CommitField(
	{ value, commit, onEscape, ...rest }:
	// `ref` is an ordinary prop on a function component in React 19, so it rides in
	// `rest` and lands on the <input> with everything else — no forwardRef.
	{ value: string | number; commit: (v: string) => void; onEscape?: () => void;
	  ref?: Ref<HTMLInputElement> }
	& Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">,
) {
	const [draft, setDraft] = useState(String(value));
	const seen = useRef(value);
	// Not an effect on [value]: that would also fire after OUR OWN commit and stamp
	// on a field the user has already started retyping. Comparing against the last
	// value we were given makes this "the document changed", not "a render happened".
	if (seen.current !== value) { seen.current = value; if (draft !== String(value)) setDraft(String(value)); }
	return (
		<input {...rest} value={draft}
		       onChange={e => setDraft(e.target.value)}
		       onBlur={() => commit(draft)}
		       onKeyDown={e => {
		         if (e.key === "Enter") (e.target as HTMLInputElement).blur();
		         else if (e.key === "Escape") {
		           // ABANDON, and do not let it through. The page's global Escape
		           // clears the selection, which would close the panel out from under
		           // someone who only meant to undo a half-typed value.
		           setDraft(String(value));
		           (e.target as HTMLInputElement).blur();
		           onEscape?.();
		           e.stopPropagation();
		         }
		       }} />
	);
}

/** NATIVE `change`, not React's. A colour input fires `input` continuously as you
 *  DRAG, so React's `onChange` would send one command per pixel — which either
 *  floods the room's log with sixty near-identical writes or, as it did once,
 *  pushed nothing at all, so ⌘Z after picking a colour undid whatever came before
 *  it. `change` fires once, when the picker closes: exactly one undoable act. */
export function ColorField(
	{ value, commit, ...rest }:
	{ value: string; commit: (v: string) => void }
	& Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type" | "defaultValue">,
) {
	const ref = useNativeChange<HTMLInputElement>(e => commit((e.target as HTMLInputElement).value));
	// Uncontrolled with a key: the picker owns the value while it is open, and a
	// change to the DOCUMENT's colour remounts it with the new one.
	return <input {...rest} ref={ref} key={value} type="color" defaultValue={value} />;
}
