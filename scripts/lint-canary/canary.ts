// The lint meta-test's canary (sync-server/test/lint-engine.test.ts). `bun lint.ts --canary` must
// report no-floating-promises here: it only exists when types flow, so it proves the engine is
// type-aware and finds this folder's tsconfig. The real run never lints this folder.
async function work(): Promise<void> {}
work();
