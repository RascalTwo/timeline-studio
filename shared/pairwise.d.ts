// The part of the vendored @rascaltwo/pairwise-sorter (pairwise.js, generated — see
// scripts/sync-vendor.ts) that shared/ calls. Hand-written because it is small and the
// library's own declarations are split across files; sync-server/test/ranking.test.ts
// exercises every function declared here, so a signature that drifts fails there.

/** -1: the first item wins · 1: the second · 0: equal. */
export type Verdict = -1 | 0 | 1;
/** An answer: pair key, verdict relative to the key's sorted order, `true` when implied. */
export type LogEntry = [key: string, verdict: Verdict, implied?: true];
/** What the library needs of an item: its identity (`key`) and tags (for tiers). */
export interface RankItem { key: string; title: string; tags: string[] }

export function pairKeyOf(idA: string, idB: string): string;
export function flipOfIds(idA: string, idB: string): 1 | -1;
export function orient(v: Verdict, sign: number): Verdict;
export function replay(items: readonly RankItem[], log: readonly LogEntry[], priority?: readonly string[]):
  { order: number[]; unplaced: number[]; next: [number, number] | null };
export function retireLog(items: readonly RankItem[], log: readonly LogEntry[], ids: readonly string[],
  priority?: readonly string[]): LogEntry[];
export function rankRows(order: readonly number[], items: readonly RankItem[], log: readonly LogEntry[]):
  { rows: { index: number; rank: number; tied: boolean }[]; rankById: Map<string, number> };
/** The slice of the sorted-so-far list a new item can still land in, narrowed by what `known` already
 *  settles (`known(n, o)` is the verdict between item `n` and the already-placed item `o`, or null). */
export function slotsFor(n: number, out: readonly number[], known: (n: number, o: number) => Verdict | null): [lo: number, hi: number];
