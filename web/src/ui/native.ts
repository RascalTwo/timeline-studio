// REACT'S `onChange` IS THE DOM `input` EVENT. Not a quirk to work around — it is
// documented, deliberate, and right for most fields. It is wrong for the ones this
// page deliberately wired to native `change`, and each of those had a reason
// written beside it:
//
//   <input type="color">  fires `input` continuously as you DRAG. On React's
//                         onChange that is one `patchDoc` per pixel, into a
//                         command log the whole room reads.
//   #url                  `setTaskUrl` refuses anything that is not http(s), so a
//                         per-keystroke emit is refused at "h", at "ht", at "htt".
//   #dur, #ref            a command per character of a number somebody is typing,
//                         or of a reference they pasted.
//
// The text fields commit on blur or Enter — `<CommitField>` in Inspector.tsx —
// because that is what `change` means for text. A colour picker has no Enter and
// may not blur, so it needs the real event.
import { useEffect, useRef } from "react";

/** Attaches a real `change` listener to the element the returned ref is put on.
 *  The handler is read from a ref, so it can close over fresh props without the
 *  listener being torn down and rebuilt on every render. */
export function useNativeChange<T extends HTMLElement>(fn: (e: Event) => void) {
	const ref = useRef<T>(null);
	const latest = useRef(fn);
	latest.current = fn;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const h = (e: Event) => latest.current(e);
		el.addEventListener("change", h);
		return () => el.removeEventListener("change", h);
	}, []);
	return ref;
}
