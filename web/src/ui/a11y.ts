// SMALL HELPERS FOR ACCESSIBLE MARKUP, kept out of the component files (a file that exports both
// components and plain functions breaks fast refresh).
import type { KeyboardEvent, MouseEvent } from "react";

/** A NON-BUTTON THAT ACTS AS ONE, for the keyboard as well as the mouse: a role, a tab stop, and
 *  Enter/Space doing what the click does. Spread it onto the element. The keys only count when they
 *  land on the element itself, so typing a space into an input INSIDE a clickable card is not a
 *  click on the card. `onClick` gets the same event the element would have had without this. */
export function asButton(onActivate: (e: MouseEvent | KeyboardEvent) => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
      e.preventDefault();
      onActivate(e);
    },
  };
}

/** `ref={focusOnMount}`: focus an element when it appears, which is what `autoFocus` does, for a field
 *  the person has just asked for (Edit on a comment). A module-level function, so React calls it on
 *  mount only and not on every render. */
export const focusOnMount = (el: HTMLElement | null) => el?.focus();
