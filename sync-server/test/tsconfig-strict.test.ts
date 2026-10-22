// THE STRICTNESS RATCHET. Every TypeScript program here is held to the flag set viz holds its own
// code to (`STRICT` in viz's lib/verify/types.ts), plus three of our own, and this test fails if any
// tsconfig drifts back. It reads the configs; it does not re-run tsc (`npm test` already compiles
// sync-server, the build compiles shared and web, and `check` in scripts/ compiles the harness).
//
// It also holds the suppression comments to a written reason, in the manner of ESLint's
// `@typescript-eslint/ban-ts-comment` (allow-with-description) and `eslint-comments/require-description`.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const ROOT = path.join(import.meta.dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");

/** viz's `STRICT`, minus the lines that are about where code runs (target, module, lib, skipLibCheck),
 *  plus ours. No program deviates: `noPropertyAccessFromIndexSignature` is on everywhere, though viz
 *  itself turns it off for its backend. */
const STRICT = {
  strict: true,
  noImplicitAny: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitOverride: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noPropertyAccessFromIndexSignature: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  moduleDetection: "force",
  // Ours. The harness and the server tests run under Bun/tsx, which only strip types, so syntax
  // that needs a transform (enums, parameter properties) is the thing to keep out.
  noUncheckedSideEffectImports: true,
  erasableSyntaxOnly: true,
} as const;

/** What `strict: true` switches on. A program may leave them unset, never turn one off. */
const STRICT_FAMILY = [
  "alwaysStrict",
  "noImplicitAny",
  "noImplicitThis",
  "strictBindCallApply",
  "strictFunctionTypes",
  "strictNullChecks",
  "strictPropertyInitialization",
  "useUnknownInCatchVariables",
];

const PROGRAMS = ["shared", "web", "sync-server", "scripts"];

for (const program of PROGRAMS) {
  await test(`Given ${program}/tsconfig.json, when its compilerOptions are read, then it holds the whole STRICT set`, () => {
    const { compilerOptions: opts } = JSON.parse(read(program, "tsconfig.json"));
    for (const [flag, want] of Object.entries(STRICT))
      assert.equal(opts[flag], want, `${program}/tsconfig.json: ${flag} must be ${want}`);
    for (const flag of STRICT_FAMILY)
      assert.notEqual(opts[flag], false, `${program}/tsconfig.json turns ${flag} back off`);
  });
}

// ── suppression comments ────────────────────────────────────────────────────────────────────────

const DIRECTIVE = /^[\s/*]*@ts-(ignore|expect-error|nocheck)\b(.*)$/u;
const MIN_REASON = 8;

/** Every `@ts-*` directive comment in `source`, with the reason written after it. Found through the
 *  parser, so a directive-looking string or template literal is not a comment and is not counted. */
function directivesIn(source: string): { kind: string; reason: string; line: number }[] {
  const sf = ts.createSourceFile("x.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const seen = new Set<number>();
  const out: { kind: string; reason: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    for (const ranges of [
      ts.getLeadingCommentRanges(source, node.getFullStart()),
      ts.getTrailingCommentRanges(source, node.getEnd()),
    ])
      for (const r of ranges ?? []) {
        if (seen.has(r.pos)) continue;
        seen.add(r.pos);
        const body = source.slice(
          r.pos + 2,
          r.kind === ts.SyntaxKind.MultiLineCommentTrivia ? r.end - 2 : r.end,
        );
        // tsc reads a block comment's last line, a line comment's only line.
        const m = DIRECTIVE.exec(body.split("\n").at(-1)!);
        if (m)
          out.push({
            kind: m[1]!,
            reason: m[2]!.replace(/^[\s\-—:]+/u, "").trim(),
            line: sf.getLineAndCharacterOfPosition(r.pos).line + 1,
          });
      }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return out;
}

/** The source trees the rule covers: shared/, web/src, sync-server/src and test, scripts/*.ts. Not
 *  `.d.ts` (shared/ emits them beside the sources), not node_modules, not build output. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, recurse: boolean) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recurse && !["node_modules", "dist"].includes(e.name)) walk(rel, true);
      } else if (/\.tsx?$/u.test(e.name) && !e.name.endsWith(".d.ts")) out.push(rel);
    }
  };
  walk("shared", false);
  walk("web/src", true);
  walk("sync-server/src", true);
  walk("sync-server/test", true);
  walk("scripts", false);
  return out;
}

await test("Given a source with bare, throwaway and described directives, when scanned, then only the described ones carry a reason", () => {
  const found = directivesIn(
    [
      "// @ts-ignore",
      "// @ts-expect-error",
      "// @ts-expect-error: todo",
      "// @ts-ignore - fix",
      "// @ts-expect-error — ADR 0002: the page imports it from the site root",
      "/* @ts-ignore the CDN has no types */",
      "// @ts-nocheck",
      'const a = "// @ts-ignore";',
      "const b = `// @ts-expect-error`;",
      "// see @ts-ignore in the notes",
    ].join("\n"),
  );
  assert.deepEqual(
    found.map((d) => [d.kind, d.reason.length >= MIN_REASON]),
    [
      ["ignore", false],
      ["expect-error", false],
      ["expect-error", false],
      ["ignore", false],
      ["expect-error", true],
      ["ignore", true],
      ["nocheck", false],
    ],
  );
});

await test("Given the source trees, when every @ts-ignore, @ts-expect-error and @ts-nocheck is found, then none is @ts-nocheck and each other one says why", () => {
  const files = sourceFiles();
  // THE GUARD ON THE GUARD: a scan that found nothing proves nothing. This repo has ~90 such files.
  assert.ok(files.length >= 60, `only found ${files.length} source files — the walk is broken`);
  for (const tree of ["shared/", "web/src/", "sync-server/src/", "sync-server/test/", "scripts/"])
    assert.ok(
      files.some((f) => f.startsWith(tree)),
      `no source file found under ${tree}`,
    );

  const bad: string[] = [];
  for (const f of files)
    for (const d of directivesIn(read(f))) {
      if (d.kind === "nocheck") bad.push(`${f}:${d.line}: @ts-nocheck is banned`);
      else if (d.reason.length < MIN_REASON)
        bad.push(
          `${f}:${d.line}: @ts-${d.kind} needs a reason of at least ${MIN_REASON} characters`,
        );
    }
  assert.deepEqual(bad, []);
});

// ── the harness is part of the gate ─────────────────────────────────────────────────────────────

await test("Given scripts/package.json, when its check script is read, then it type-checks the harness", () => {
  const { scripts } = JSON.parse(read("scripts", "package.json"));
  const tsc = /\btsc\b[^&|]*-p\s+tsconfig\.json\b/u;
  assert.match(
    scripts.check,
    tsc,
    "`check` must run tsc -p tsconfig.json (the harness is never compiled otherwise)",
  );
  assert.match(scripts.typecheck, tsc, "`typecheck` must cover the harness too");
});
