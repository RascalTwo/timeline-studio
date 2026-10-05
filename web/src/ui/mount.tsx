// WHERE REACT IS ALLOWED TO TOUCH THE PAGE.
//
// The page is being migrated region by region rather than rewritten: `app.ts`
// still owns the document, the socket, the scheduler wrappers and most of the
// DOM, and React owns a growing set of containers. This file is the seam, and it
// exists so that the set of containers React owns is a LIST somebody can read,
// rather than a fact you assemble by grepping for `createRoot`.
//
// ONE ROOT PER CONTAINER, FOREVER. `createRoot` on an element that already has a
// root does not replace it — it makes a second one, and the second one renders
// into nodes the first is still reconciling against. The symptom is a region
// that updates on some renders and not others, which is a bad afternoon. The
// WeakMap makes that unrepresentable and lets the container be garbage collected
// if it is ever removed.
//
// `app.ts` STAYS PLAIN TYPESCRIPT. Everything JSX lives under `ui/`, so the file
// that three other tools read by path — `verify.sched.mjs` slices declarations
// out of it, `selectors.test.ts` scans it, `index.html` names it as the entry —
// does not change its extension for the sake of an angle bracket.
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { MilestoneBar, type MilestoneBarProps } from "./MilestoneBar.js";
import { Inspector, type InspectorProps, type InspectorTask } from "./Inspector.js";
import { Legend, type LegendProps } from "./Legend.js";
import { ChannelEditor, type ChannelEditorProps } from "./ChannelEditor.js";
import { SwapEditor, type SwapEditorProps } from "./SwapEditor.js";
import { ReorderPanel, type ReorderPanelProps } from "./ReorderPanel.js";
import { PastPlans, type PastPlan, type OnPastAnswer } from "./PastPlans.js";
import { TaskCard } from "./TaskCard.js";
import { History, type HistoryProps } from "./History.js";
import { Playbar, type PlaybarProps } from "./Playbar.js";
import { Grid, type GridProps } from "./Grid.js";
import { PlanName, type PlanNameProps } from "./PlanName.js";
import { Who, Cursors, type WhoChip, type Cursor } from "./Presence.js";
import { Picker, type PickerProps, type PickerOption } from "./Picker.js";
import { Furniture, Axis, type Band, type Rule, type AxisLabel } from "./Furniture.js";
import { Arrows, type Arrow } from "./Arrows.js";
import { SchedulerDown, WakeSplash, ImportSummary, SelfTestFailed, PlanUnopenable,
         GraphUnavailable, type ImportedPlan } from "./Banners.js";
import { Recents, KeyringSample, MentionsList, MentionsSub, StylePop,
         type RecentPlan, type Mention, type MentionsProps } from "./Panels.js";
import type { Swatch as SwatchT } from "./fields.js";
import { Assistant, type AssistantProps } from "./Assistant.js";
import { Notice, NoticeEditor, type NoticeProps, type NoticeEditorProps } from "./Notice.js";
import { WeekEditor, ArrowEditor, SwatchWall, LabelPartsEditor, MiniChip,
         type WeekEditorProps, type ArrowEditorProps, type SwatchRow,
         type LabelPartsProps } from "./Editors.js";

const roots = new WeakMap<Element, Root>();

function mount(el: Element, node: ReactNode) {
	let r = roots.get(el);
	if (!r) roots.set(el, (r = createRoot(el)));
	r.render(node);
}

export function mountMilestoneBar(el: Element, props: MilestoneBarProps) {
	mount(el, <MilestoneBar {...props} />);
}

export function mountTaskCard(el: Element, task: InspectorTask) {
	mount(el, <TaskCard task={task} />);
}

export function mountInspector(el: Element, props: InspectorProps) {
	mount(el, <Inspector {...props} />);
}

export function mountLegend(el: Element, props: LegendProps) {
	mount(el, <Legend {...props} />);
}

export function mountWeekEditor(el: Element, props: WeekEditorProps) {
	mount(el, <WeekEditor {...props} />);
}

export function mountArrowEditor(el: Element, props: ArrowEditorProps) {
	mount(el, <ArrowEditor {...props} />);
}

export function mountSwatchWall(el: Element, rows: SwatchRow[]) {
	mount(el, <SwatchWall rows={rows} />);
}

export function mountLabelParts(el: Element, props: LabelPartsProps) {
	mount(el, <LabelPartsEditor {...props} />);
}

export function mountNotice(el: Element, props: NoticeProps) {
	mount(el, <Notice {...props} />);
}

export function mountNoticeEditor(el: Element, props: NoticeEditorProps) {
	mount(el, <NoticeEditor {...props} />);
}

export function mountMiniChip(el: Element,
                              p: { title: string; milestone: string; verdict: string; tone: string }) {
	mount(el, <MiniChip {...p} />);
}

export function mountChannelEditor(el: Element, props: ChannelEditorProps) {
	mount(el, <ChannelEditor {...props} />);
}

export function mountSwapEditor(el: Element, props: SwapEditorProps) {
	mount(el, <SwapEditor {...props} />);
}

export function mountReorderPanel(el: Element, props: ReorderPanelProps) {
	mount(el, <ReorderPanel {...props} />);
}

export function mountPastPlans(el: Element, props: { plans: PastPlan[]; onAnswer: OnPastAnswer; active: boolean }) {
	mount(el, <PastPlans {...props} />);
}
export type { PastPlan, OnPastAnswer };

export function mountHistory(el: Element, props: HistoryProps) {
	mount(el, <History {...props} />);
}

export function mountPlaybar(el: Element, props: PlaybarProps) {
	mount(el, <Playbar {...props} />);
}

export function mountWho(el: Element, chips: WhoChip[], onRename: () => void) {
	mount(el, <Who chips={chips} onRename={onRename} />);
}

export function mountCursors(el: Element, cursors: Cursor[]) {
	mount(el, <Cursors cursors={cursors} />);
}

export function mountRecents(el: Element, plans: RecentPlan[], onOpen: (tok: string) => void) {
	mount(el, <Recents plans={plans} onOpen={onOpen} />);
}

export function mountKeyringSample(el: Element, p: { base: string; ref: string | null; url: string | null }) {
	mount(el, <KeyringSample {...p} />);
}

export function mountMentions(el: Element, props: MentionsProps) {
	mount(el, <MentionsList {...props} />);
}

export function mountMentionsSub(el: Element, p: { newName: string; count: number }) {
	mount(el, <MentionsSub {...p} />);
}

export function mountStylePop(el: Element, opts: { v: string; swatch: SwatchT; on: boolean }[],
                              onPick: (v: string) => void) {
	mount(el, <StylePop opts={opts} onPick={onPick} />);
}

// INTO THE `<svg>` ITSELF. React takes the container's namespace, so `<path>`
// children of an SVG root are created in the SVG namespace and not the HTML one.
export function mountArrows(el: Element, arrows: Arrow[]) {
	mount(el, <Arrows arrows={arrows} />);
}

export function mountFurniture(el: Element, p: { bands: Band[]; rules: Rule[] }) {
	mount(el, <Furniture {...p} />);
}

export function mountAxis(el: Element, labels: AxisLabel[]) {
	mount(el, <Axis labels={labels} />);
}

export function mountPicker(el: Element, props: PickerProps) {
	mount(el, <Picker {...props} />);
}

// THE ONE-SHOT BANNERS. Their host node is made by `app.ts` and prepended to the
// body — React owns containers, and making one is not rendering.
export function mountSchedulerDown(el: Element, msg: string) {
	mount(el, <SchedulerDown msg={msg} />);
}

export function mountWakeSplash(el: Element, p: { up: boolean; secs: number; pct: number }) {
	mount(el, <WakeSplash {...p} />);
}

export function mountImportSummary(el: Element,
                                   p: { made: ImportedPlan[]; skipped: number; base: string }) {
	mount(el, <ImportSummary {...p} />);
}

export function mountSelfTestFailed(el: Element, bad: string[]) {
	mount(el, <SelfTestFailed bad={bad} />);
}

export function mountPlanUnopenable(el: Element, wanted: string, said?: string) {
	mount(el, <PlanUnopenable wanted={wanted} said={said} />);
}

export function mountGraphUnavailable(el: Element) {
	mount(el, <GraphUnavailable />);
}

export function mountGrid(el: Element, props: GridProps) {
	mount(el, <Grid {...props} />);
}

export function mountPlanName(el: Element, props: PlanNameProps) {
	mount(el, <PlanName {...props} />);
}

export type { MilestoneBarProps, MilestoneChip } from "./MilestoneBar.js";
export type { GridLane, GridRow, GridBar, LabelPart } from "./Grid.js";
export type { RecentPlan, Mention } from "./Panels.js";
export type { WhoChip, Cursor } from "./Presence.js";
export type { ImportedPlan } from "./Banners.js";
export type { PickerOption } from "./Picker.js";
export type { Band, Rule, AxisLabel } from "./Furniture.js";
export type { Arrow } from "./Arrows.js";
export type { HistoryRow, DeltaPart } from "./History.js";
export type { Suggestion } from "./ReorderPanel.js";
export type { SwapColumn, SwapRow, SwapControl } from "./SwapEditor.js";
export type { ChannelBlock, ChannelValueRow, ValueControl } from "./ChannelEditor.js";
export type { SwatchRow } from "./Editors.js";
export type { ArrowRow } from "./Editors.js";
export type { LegendProps, LegendGroup, LegendItem, Swatch } from "./Legend.js";
export type { InspectorProps, InspectorTask, Chip, Option } from "./Inspector.js";

/** Run a batch of mounts and COMMIT THEM BEFORE RETURNING.
 *
 *  `root.render()` schedules; it does not apply. Any caller that measures or
 *  writes layout immediately afterwards — `setZoom` re-anchoring the date under
 *  the pointer, `fitTimeline` scrolling to the framed span — is reading the DOM
 *  from before the change it just made, and its correction lands on the old
 *  scale. The browser then paints one frame at the new scale with the old scroll
 *  position, which is what a horizontal flicker during a pinch actually is.
 *
 *  Kept here rather than importing `flushSync` in `app.ts`, because the React
 *  dependency stops at this file (ADR 0004) and a scheduling detail is exactly
 *  the kind of thing that should not leak past it. */
export function flushMount(fn: () => void) { flushSync(fn); }

/** The voice command bar (ui/Assistant.tsx); toggled by the 🎙 button and ⌘K via `assistant:toggle`. */
export function mountAssistant(el: Element, props: AssistantProps) {
	mount(el, <Assistant {...props} />);
}
