// @bcoe/v8-coverage 1.0.2 ships no types. Only what coverage-page.ts uses.
declare module "@bcoe/v8-coverage" {
  export type RangeCov = { startOffset: number; endOffset: number; count: number };
  export type FunctionCov = {
    functionName: string;
    ranges: RangeCov[];
    isBlockCoverage: boolean;
  };
  export type ScriptCov = { scriptId: string; url: string; functions: FunctionCov[] };
  export type ProcessCov = { result: ScriptCov[] };
  /** Sums the counts of the same script (by URL) across several takes. */
  export function mergeProcessCovs(processCovs: ProcessCov[]): ProcessCov;
}
