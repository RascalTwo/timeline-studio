// lint-config.ts — which lint rules are on, and why each one that is off is off.
//
// Adapted from viz's lib/lint/config.ts (same Oxlint 1.86.0 / tsgolint 7.0.2003, so the rule set is
// the same): every category on except `style`, which the formatter (oxfmt) owns. Turning a rule off
// needs a written reason, so the exceptions ARE a map from rule to reason, and the meta-test
// (sync-server/test/lint-engine.test.ts) holds every reason to non-empty and not a placeholder.
//
// A reason must say what in THIS repo makes the rule inapplicable. One that would fit any repo
// ("taste") is not a reason. A reason that names a task (ts-qa-strict-ratchet) is temporary: delete the
// entry when that task lands and fix what it shows. Every entry was agreed one rule at a time by the
// human (task ts-qa-oxlint-gate); do not add one on your own.

/** Rule → why it is off. Names are Oxlint's, with the plugin prefix where it has one. */
export const OFF_RULES: Record<string, string> = {
  complexity:
    "web/src/app.ts is one module by design (CLAUDE.md, ADR 0004) with helpers beside their use among long explanatory comments, and docs/original/verify.sched.mjs extracts functions from it by name; a limit here would force a redesign.",
  "import/no-relative-parent-imports":
    "sync-server imports ../../shared/*.js on purpose (ADR 0001, one copy of the scheduler), its tests import ../src, and web/src/ui imports ../types.js.",
  "max-depth":
    "web/src/app.ts is one module by design (CLAUDE.md, ADR 0004) with helpers beside their use among long explanatory comments, and docs/original/verify.sched.mjs extracts functions from it by name; a limit here would force a redesign.",
  "max-lines":
    "web/src/app.ts is one module by design (CLAUDE.md, ADR 0004) with helpers beside their use among long explanatory comments, and docs/original/verify.sched.mjs extracts functions from it by name; a limit here would force a redesign.",
  "max-lines-per-function":
    "web/src/app.ts is one module by design (CLAUDE.md, ADR 0004) with helpers beside their use among long explanatory comments, and docs/original/verify.sched.mjs extracts functions from it by name; a limit here would force a redesign.",
  "no-await-in-loop":
    "Every loop awaits in order on purpose: claim-an-id retries, polling a server that is waking, chained Ollama calls, and the browser harness driving one page step by step.",
  "no-console":
    "scripts/ are CLIs whose output is the console, the server logs to stdout for the container, and the page's few calls report to the dev console.",
  "no-inline-comments":
    "A trailing note beside the line is this code base's documentation style (see AGENTS.md).",
  "no-plusplus":
    "Loop counters and tallies in a code base formatted by oxfmt; there is no ASI hazard.",
  "no-undefined":
    "Absent optional fields and missing map entries are `undefined` in the schedule and command types and are tested with ===.",
  "no-use-before-define":
    "Hoisted functions and helpers used inside earlier functions in a 12k-line module; tsc already catches the real cases (TS2448).",
  "oxc/no-async-await":
    "Every program targets ES2022 or newer (esnext in scripts/) and the server runs on Node 24, so this syntax is native; nothing is downleveled.",
  "oxc/no-optional-chaining":
    "Every program targets ES2022 or newer (esnext in scripts/) and the server runs on Node 24, so this syntax is native; nothing is downleveled.",
  "oxc/no-rest-spread-properties":
    "Every program targets ES2022 or newer (esnext in scripts/) and the server runs on Node 24, so this syntax is native; nothing is downleveled.",
  "react/jsx-filename-extension":
    "Every component file is .tsx, which TypeScript requires for JSX (Oxlint's default allows only .jsx).",
  "react/jsx-no-literals":
    "The UI is plain English labels in JSX with no translation layer; the literals are the strings.",
  "react/no-multi-comp":
    "Each web/src/ui/*.tsx holds one panel's small presentational components together, as ui/mount.tsx's list expects.",
  "react/react-in-jsx-scope":
    "web/tsconfig.json uses jsx: react-jsx, so the automatic runtime supplies React.",
  "sort-vars":
    "Reordering a `const a = ..., b = ...` list can break initializers that depend on earlier ones.",
  "typescript/explicit-function-return-type":
    "TypeScript infers return types; exported functions stay held by explicit-module-boundary-types where that rule is on.",
  "typescript/explicit-module-boundary-types":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-explicit-any":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-non-null-assertion":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-unsafe-argument":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-unsafe-assignment":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-unsafe-call":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-unsafe-member-access":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-unsafe-return":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/no-unsafe-type-assertion":
    "web/ and shared/ tsconfigs set strict and noImplicitAny to false, so an any leaks into every expression; removed by ts-qa-strict-ratchet.",
  "typescript/prefer-nullish-coalescing":
    "Decidable only once the operands are typed: most left sides are any today and the typed ones are strings and numbers that || lets fall through on purpose; revisit with ts-qa-strict-ratchet.",
  "typescript/prefer-readonly-parameter-types":
    "DOM and document types are mutable by design and the command layer mutates documents in place.",
  "typescript/strict-boolean-expressions":
    "Optional fields are tested by truthiness at about 900 sites typed any today; revisit after ts-qa-strict-ratchet.",
  "unicorn/consistent-function-scoping":
    "web/src/app.ts keeps helpers beside their use among long explanatory comments (CLAUDE.md, ADR 0004); hoisting 77 of them would separate them from the prose that explains them.",
  "unicorn/prefer-code-point":
    "The peer-colour name hash must stay identical across browsers on different builds; codePointAt would recolour names containing emoji.",
  "default-case":
    "validateCommand's switch has no default on purpose so tsc proves it exhaustive (TS2366); adding one changes what an unknown command returns.",
  "typescript/non-nullable-type-assertion-style":
    "It asks for `x!`, which no-non-null-assertion bans; the pair is settled by typing the values, removed by ts-qa-strict-ratchet.",
  "typescript/no-unnecessary-type-parameters":
    'The generic on the $ and $opt DOM helpers is how $("#x") returns the right element type at every call site; removing it means a cast at each.',
  "typescript/no-misused-spread":
    "The peer-colour name hash must stay identical across browsers on different builds; changing how the name is spread would recolour names containing emoji.",
  "typescript/no-base-to-string":
    "String() at trust boundaries (request bodies, WS frames, prompt(), imported files): typed string, arrives as anything; removing it turns bad input from a coerced value into a TypeError.",
  "typescript/no-unnecessary-type-conversion":
    "String() at trust boundaries (request bodies, WS frames, prompt(), imported files): typed string, arrives as anything; removing it turns bad input from a coerced value into a TypeError.",
  "no-alert":
    "The page uses native confirm() and prompt() for destructive confirmations and the browser suite answers them as dialogs; replacing them is new modal UI. The CLI prompt in migrate-to-s3 is not a browser dialog.",
  "oxc/no-map-spread": "Immutable-update idiom on plan-sized arrays.",
  "require-await":
    "Fastify route handlers and the fakes of async store interfaces must be async without awaiting; promise-function-async (on) demands async on promise-returning functions, so the two rules conflict.",
  "typescript/require-await":
    "Fastify route handlers and the fakes of async store interfaces must be async without awaiting; promise-function-async (on) demands async on promise-returning functions, so the two rules conflict.",
  "react/refs":
    "The latest-ref and callback-ref patterns; the flagged reads are false positives of this rule.",
  "react/set-state-in-effect":
    "The effects reset local state when the task or plan id changes; that is their purpose.",
  "react/exhaustive-effect-dependencies":
    "A task or plan id is an intentional reset-when-this-changes trigger, not an unused dependency.",
  "react/forbid-component-props":
    "CommitField forwards className and style to its <input>; that is how it is styled.",
  "react/no-danger":
    "All dangerouslySetInnerHTML values come from mdHtml(): marked piped through DOMPurify.",
  "react/no-array-index-key":
    "Positional drawing primitives (bands, gaps, segments) with no identity, rebuilt on every render.",
  "import/max-dependencies":
    "server.ts is the composition root that registers every route and web/src/ui/mount.tsx is the readable list of what React owns; many imports is their job.",
};

/** Rule → why it is off inside `test/` folders only. */
export const TEST_OFF_RULES: Record<string, string> = {};

const BASE_PLUGINS = ["typescript", "unicorn", "oxc", "import"];
const WEB_PLUGINS = [...BASE_PLUGINS, "react", "jsx-a11y"];

/**
 * The Oxlint config for one program, generated so the reasons above cannot drift from what is
 * actually off. `react` and `jsx-a11y` are for web/ only: nothing else has JSX. `exceptions: false`
 * is every rule on, for the canary and the meta-test's scratch folders: they prove the engine, so
 * a rule the repo has agreed to switch off must not be able to blind them.
 */
export function oxlintConfig(program: string, exceptions = true): Record<string, unknown> {
  const plugins = program === "web" ? WEB_PLUGINS : BASE_PLUGINS;
  // A rule of a plugin this program does not load is unknown to Oxlint there, and unknown is an error.
  const off = (rules: Record<string, string>) =>
    Object.fromEntries(
      Object.keys(rules)
        .filter((r) => !r.includes("/") || plugins.includes(r.split("/")[0]!))
        .map((r) => [r, "off"]),
    );
  return {
    plugins,
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
      pedantic: "error",
      restriction: "error",
    },
    rules: exceptions ? off(OFF_RULES) : {},
    overrides: [{ files: ["**/test/**"], rules: exceptions ? off(TEST_OFF_RULES) : {} }],
  };
}
