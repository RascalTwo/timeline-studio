// GENERIC LAYOUT AUDIT, ported from viz's verify (skills/viz/lib/verify/verify.ts, the "Layout audit"
// block). Three checks, none of which needs to know what a view looks like:
//
//   clipped            content cut off by an `overflow: hidden|clip` box: the silent failure, because
//                      the screenshot still looks fine and the words are simply missing
//   viewport-overflow  the page scrolls sideways
//   blank              a lens that drew nothing
//
// NOT PORTED: viz's SVG <text> spill check (about chart labels) and its og-card check (no og card here).
//
// DEPARTURES FROM VIZ, each on purpose:
//   - An element whose computed `text-overflow` is `ellipsis` is not reported. A truncated label also has
//     scrollWidth > clientWidth, but its visible "…" says it was cut; the audit is for the clips that say
//     nothing. (ts-qa-layout-audit, question 1.)
//   - Blank is judged per LENS root, not per page. Viz's page-level test (no marks and under 10 characters
//     of text) cannot fail here: the toolbar alone is more text than that.
//   - Findings are returned, not logged, so the harness can make each one a `check(...)` line.
//
// `data-verify-clip-ok="<reason>"` on a box (or any ancestor) exempts it, same attribute as viz. The reason
// is the author's claim; nothing in the app carries one today.
import type { Page } from "puppeteer-core";

export type AuditFindings = { clipped: string[]; overflow: string[]; blank: string[] };

/** The element that holds each lens's content, and the thing to name when it is empty. */
export const LENS_ROOTS: Record<string, string> = {
  timeline: "#rows",
  relative: "#rows",
  graph: "#cy",
  board: "#board",
  calendar: "#calbody",
};

// PLAIN JS IN A STRING, like every other page.evaluate in the harness: this program's lib is esnext with
// no DOM, and giving it one retypes puppeteer's handles across the whole harness.
const inPage = (rootSel: string, only: string) => `((rootSel, only) => {
  const sel = (el) => {
    if (el.id) return "#" + el.id;
    const vid = el.getAttribute("data-viz-id");
    if (vid) return '[data-viz-id="' + vid + '"]';
    const label = el.getAttribute("data-label") || el.getAttribute("aria-label");
    const cls = [...el.classList].slice(0, 2).map((c) => "." + c).join("");
    return el.tagName.toLowerCase() + cls + (label ? ' "' + label.slice(0, 30) + '"' : "");
  };
  const txt = (el) => (el.textContent || "").trim().replaceAll(/\\s+/gu, " ").slice(0, 40);
  const cap = (arr, n) => (arr.length > n ? [...arr.slice(0, n), "…and " + (arr.length - n) + " more"] : arr);
  const hides = (v) => /hidden|clip/u.test(v);
  const found = { clipped: [], overflow: [], blank: [] };

  // 1. Clipped content. Only boxes on screen: a hidden lens has no client size.
  if (only === "all") {
    for (const el of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(el);
      if (!hides(cs.overflow) && !hides(cs.overflowX) && !hides(cs.overflowY)) continue;
      if (!el.clientHeight && !el.clientWidth) continue;
      if (el.clientHeight <= 1 && el.clientWidth <= 1) continue; // the screen-reader-only pattern
      if (cs.textOverflow === "ellipsis") continue; // the "…" is the signal
      if (el.closest("[data-verify-clip-ok]")) continue;
      let dy = el.scrollHeight - el.clientHeight;
      let dx = el.scrollWidth - el.clientWidth;
      if (dy > 2 || dx > 2) {
        // Parked content (visibility:hidden, nudged past the edge) pads the scroll size without cutting
        // anything off the screen: measure again with it out of layout.
        const parked = [...el.querySelectorAll("*")].filter((c) => getComputedStyle(c).visibility === "hidden");
        const css = parked.map((c) => c.style.cssText);
        for (const c of parked) c.style.setProperty("display", "none", "important");
        dy = el.scrollHeight - el.clientHeight;
        dx = el.scrollWidth - el.clientWidth;
        for (const [i, c] of parked.entries()) c.style.cssText = css[i] ?? "";
      }
      if (dy > 2 || dx > 2) {
        const dir = dy > 2 ? dy + "px vertically" : dx + "px horizontally";
        found.clipped.push(sel(el) + (txt(el) ? ' "' + txt(el) + '"' : "") + " is cut off by " + dir);
      }
    }
    found.clipped = cap(found.clipped, 8);
  }

  // 2. Anything wider than the viewport.
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 2) {
    const wide = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > de.clientWidth + 2)
      .slice(0, 4)
      .map((el) => sel(el));
    found.overflow.push(
      "page scrolls horizontally (" + de.scrollWidth + "px > " + de.clientWidth + "px viewport)" +
        (wide.length > 0 ? " — widest: " + wide.join(", ") : ""),
    );
  }

  // 3. Did the lens draw anything? Marks or text inside ITS root.
  if (only === "all") {
    const root = document.querySelector(rootSel);
    if (!root || !root.offsetWidth || !root.offsetHeight)
      found.blank.push(rootSel + " is missing or has no size");
    else if (!root.querySelector("svg *, canvas, img") && (root.innerText || "").trim().length < 10)
      found.blank.push(rootSel + " has no marks and almost no text");
  }
  return found;
})(${JSON.stringify(rootSel)}, ${JSON.stringify(only)})`;

export const auditLayout = async (
  page: Page,
  lens: string,
  only: "all" | "overflow" = "all",
): Promise<AuditFindings> =>
  (await page.evaluate(inPage(LENS_ROOTS[lens] ?? "#chart", only))) as AuditFindings;
