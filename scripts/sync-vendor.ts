// VENDORED LIBRARIES: any package web/ can install, bundled into one flat file in shared/.
//
// Why a vendored copy and not an import: `shared/` is served to the page raw, not bundled
// (ADR 0004), and hashed by the server so both sides provably run the same bytes (ADR 0001).
// A bare `import "some-package"` means nothing to a browser loading /commands.js, so a
// library shared/ calls has to live in shared/ as a real file.
//
// THE LIST is `vendor` in web/package.json — import specifier → file in shared/:
//   "vendor": { "@rascaltwo/pairwise-sorter": "pairwise.js" }
// The pin is that package's entry in `dependencies`, so anything npm can install works:
// `github:owner/repo#sha`, a registry version, a tarball URL. The header of each file
// records the pin and a hash of the body; sync-server/test/vendor.test.ts fails when either
// is off — a stale sync, or a hand edit. Each file also gets its web/ symlink, which is what
// makes it a shared file everywhere else (parity, deploy, dev server — they all derive the
// list from those links).
//
//   npm --prefix web install --save-exact <pkg>  (a range like ^5 pins nothing)
//   add a `vendor` entry → bun scripts/sync-vendor.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, symlinkSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dir, "..");
const WEB = path.join(ROOT, "web");
const pkg = await Bun.file(path.join(WEB, "package.json")).json();
// Bun writes each module's path into the bundle relative to the cwd, so the same pin gave
// different bytes depending on where this was run from. Always from the project root.
process.chdir(ROOT);

/** "@scope/name/sub" → "@scope/name"; "name/sub" → "name". */
const packageOf = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

for (const [spec, file] of Object.entries<string>(pkg.vendor ?? {})) {
  const pin: string | undefined = pkg.dependencies?.[packageOf(spec)];
  if (!pin) throw new Error(`vendor "${spec}" has no entry in web/package.json dependencies — add it there first`);
  const built = await Bun.build({ entrypoints: [Bun.resolveSync(spec, WEB)], format: "esm", target: "browser" });
  if (!built.success) throw new AggregateError(built.logs, `bundling ${spec} failed`);
  const body = await built.outputs[0]!.text();
  const sha = createHash("sha256").update(body).digest("hex");
  await Bun.write(path.join(ROOT, "shared", file),
    `// GENERATED from ${spec} (${pin}) by scripts/sync-vendor.ts — do not edit.\n// body-sha256: ${sha}\n${body}`);
  if (!existsSync(path.join(WEB, file))) symlinkSync(`../shared/${file}`, path.join(WEB, file));
  // shared/*.js is gitignored (tsc output), so a new vendored file would silently never be
  // committed — and the server image and the bucket need its bytes. Un-ignore it.
  if (Bun.spawnSync(["git", "check-ignore", "-q", `shared/${file}`]).exitCode === 0) {
    const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim();
    const rel = path.relative(top, path.join(ROOT, "shared", file));
    appendFileSync(path.join(top, ".gitignore"), `!${rel}\n`);
    console.log(`  .gitignore: un-ignored ${rel}`);
  }
  console.log(`shared/${file} ← ${spec} ${pin}`);
}
