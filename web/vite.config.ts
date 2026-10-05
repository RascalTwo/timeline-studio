// @ts-ignore — `web/tsconfig.json` carries only `vite/client` types, and pulling
// `@types/node` into a package with no other use for it costs more than the two
// declarations this file already makes. See the `process` declaration below.
import { createReadStream, lstatSync, readdirSync, realpathSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `web/tsconfig.json` deliberately carries only `vite/client` types, so this
// file cannot reach for `node:url` or an ambient `process` without dragging
// `@types/node` into a package that has no other use for it. Two declarations
// are cheaper than the dependency, and both are true of every runtime that has
// ever executed this config.
declare const process: { env: Record<string, string | undefined> };

// `decodeURIComponent` because `URL.pathname` percent-encodes, and a repo path
// containing a space would otherwise resolve to a file that does not exist.
const at = (rel: string) =>
  decodeURIComponent(new URL(rel, import.meta.url).pathname);
const shared = (name: string) => at(`../shared/${name}`);

// THE SHARED FILES ARE NOT BUNDLED, AND THAT IS THE WHOLE CONFIGURATION.
//
// `shared/schedule.js` and `shared/commands.js` reach production down two
// pipelines — the web deploy uploads them to the bucket, the Docker build copies
// `shared/` into the image — and `scripts/assert-shared-parity.sh` proves the two
// copies are byte-identical before a deploy lands. ADR 0001 is that gate.
//
// A bundler defeats it silently. If Rollup inlines `schedule.js` into the app
// chunk, the browser stops running the file at `/schedule.js` and starts running
// a transformed copy of it; the gate goes on comparing `shared/schedule.js` to
// the server's hash, both sides go on matching, and the comparison no longer
// describes anything the page does. That is not a weaker gate, it is a gate that
// reports green about a file nobody loads.
//
// So they stay external: the emitted bundle carries a real `import` of
// `/schedule.js`, the browser fetches the same bytes the server hashed, and the
// parity script's premise — "the page can only import a shared file if `web/`
// symlinks to it" — is still true after the bundler arrived.
//
// `scripts/playback-harness.ts` asserts this, because a config comment cannot.
// WHICH FILES ARE SHARED is the web/ symlinks into shared/ — the same rule
// scripts/assert-shared-parity.sh derives its manifest from — so a vendored library
// (scripts/sync-vendor.ts) becomes one by getting its link, with no list to update here.
const SHARED_NAMES = readdirSync(at(".")).filter((n) =>
  n.endsWith(".js") && lstatSync(at(n)).isSymbolicLink() && realpathSync(at(n)).startsWith(realpathSync(at("../shared")) + "/"));
const SHARED = SHARED_NAMES.map((n) => `./${n}`);

const sharedPaths = (id: string) => {
  const name = id.split("/").pop()!;
  return SHARED_NAMES.includes(name) ? `/${name}` : id;
};

// THE TWO SHARED FILES HAVE NO SERVER LOCALLY, and nothing noticed until someone
// tried to run the built page on this machine. They are deliberately not in
// `dist` — `publicDir` is off and the deploy syncs them to the bucket root as
// their own step — so `vite preview` answers `/schedule.js` with the SPA
// fallback: `index.html`, at `Content-Type: text/html`. The bundle's
// `import "/schedule.js"` then parses HTML as a module, the entry never
// executes, and what is left on screen is the static toolbar out of index.html
// with an empty chart under it. It looks like a plan that would not load.
//
// Serving them from `shared/` is also the only correct answer rather than a
// convenient one: ADR 0001 is that the browser runs the same BYTES the server
// hashed, and these are those bytes rather than a copy of them.
// WHAT AN AGENT ARRIVING WITH ONLY A URL CAN FIND. `/llms.txt` is the
// convention a model checks by habit, `/AGENTS.md` is what the page's own
// header comment tells it to read, and `/commands.js` is the vocabulary as
// code. All three are uploaded by `deploy-web.sh`, so production has served
// them for a while and only local dev did not — the SPA fallback answered
// `/AGENTS.md` with `index.html` at `Content-Type: text/html`, which reads to a
// fetcher as "this site has no agent surface".
const SERVED: Record<string, { file: string; type: string }> = {
  ...Object.fromEntries(SHARED_NAMES.map((n) => [n, { file: `../shared/${n}`, type: "text/javascript" }])),
  "AGENTS.md": { file: "./AGENTS.md", type: "text/markdown; charset=utf-8" },
  "llms.txt": { file: "./llms.txt", type: "text/plain; charset=utf-8" },
};

const serveShared = () => {
  // RETURNS NOTHING, DELIBERATELY. Vite treats a hook's return value as a
  // post-hook to invoke once its own middlewares are installed, and
  // `middlewares.use()` returns the connect app — so an arrow body handed Vite
  // the app itself, which it then called with no request. The preview server
  // died on startup with "Cannot read properties of undefined (reading 'url')".
  const middleware = (server: { middlewares: { use: (fn: any) => void } }) => {
    server.middlewares.use((req: any, res: any, next: any) => {
      const name = (req.url || "").split("?")[0].replace(/^\//, "");
      const hit = SERVED[name];
      if (!hit) return next();
      res.setHeader("Content-Type", hit.type);
      createReadStream(at(hit.file)).pipe(res);
    });
  };
  return { name: "serve-shared", configureServer: middleware, configurePreviewServer: middleware };
};

// THE PLAN CHAT'S TRACES (src/tracing.ts) go to a local Phoenix through this same-origin path, because
// Phoenix answers a browser's CORS preflight with 405. No Phoenix behind it: /phoenix/healthz fails and
// the page never loads the tracing code. PHOENIX_URL points it elsewhere.
const PHOENIX = { "/phoenix": { target: process.env.PHOENIX_URL ?? "http://localhost:6788",
  rewrite: (p: string) => p.replace(/^\/phoenix/, "") } };

export default defineConfig(({ command }) => ({
  plugins: [react(), serveShared()],
  // DEV ONLY, AND IT MUST STAY DEV ONLY. `src/app.ts` imports `./schedule.js`,
  // which is relative to `src/` — but the symlinks are at `web/` root, so the
  // specifier resolves to nothing under `vite dev` and the page never loads.
  // The build does not care: rollup treats the specifier as external and the
  // `paths` hook below rewrites it to `/schedule.js`.
  //
  // So this alias exists to make `serve` behave like `build` already does, and
  // it is guarded on `command` because applying it to a build would be a quiet
  // disaster: the alias rewrites the specifier to an absolute path, `external`
  // stops matching `./schedule.js`, rollup inlines the scheduler, and
  // `assert-shared-parity.sh` goes on comparing two files the page no longer
  // loads — the exact failure ADR 0001 exists to prevent, described at length
  // in the comment above.
  //
  // Symlinking the two files into `src/` would also work and was rejected: the
  // parity manifest IS the set of symlinks under `web/`, so a second set would
  // either be silently ignored or double-counted, and which one is a detail of
  // how that script globs.
  resolve:
    command === "serve"
      ? {
          alias: {
            "./schedule.js": shared("schedule.js"),
            "./commands.js": shared("commands.js"),
          },
        }
      : undefined,
  // DEV ONLY, AND `ws: true` IS THE HALF THAT IS EASY TO MISS. In production the
  // page and `/api/*` are the same origin behind CloudFront, so the app asks for
  // `api/…` relative to itself and there is nothing to configure. Under `vite
  // dev` the page is on 5173 and the sync server is on 8080, so every `api/`
  // call 404s against Vite's own static handler unless it is forwarded.
  //
  // The websocket needs forwarding too: `app.ts` opens `new URL("api/connect",
  // location.href)`, which is the same prefix, but Vite does not upgrade a
  // proxied connection unless the route says so. Without `ws: true` the page
  // loads, reads the plan over HTTP, and then silently never receives an
  // update — the worst of the three failure modes, because it looks like it
  // works.
  //
  // `SYNC_PORT` because 8080 is not reliably free — podman's `gvproxy` takes it
  // on at least one machine here — and the server reads the same number from
  // `PORT`. `scripts/local-up.sh` sets both from one place; the default matches
  // the server's own so nothing changes for anyone who has 8080 spare.
  //
  // BOTH SERVERS, because `preview` is the one to actually use. `src/app.ts` is
  // over 400 kB in a single module and the graph lens pulls another 435 kB of
  // cytoscape; served unbundled by `dev`, a browser spends long enough
  // transforming that it reads as a hung tab. `preview` serves the same build
  // the deploy ships and the harness tests, and needs the identical proxy —
  // `vite` keeps the two configs separate, so this is not a duplicate that can
  // be collapsed.
  server: { proxy: { "/api": { target: `http://localhost:${process.env.SYNC_PORT ?? 8080}`, ws: true }, ...PHOENIX } },
  preview: { proxy: { "/api": { target: `http://localhost:${process.env.SYNC_PORT ?? 8080}`, ws: true }, ...PHOENIX } },
  // THE WORKER IS SUBJECT TO THE SAME RULE, and saying so here is the whole
  // reason this block exists. `src/reorder-worker.ts` imports `./schedule.js`,
  // and Vite builds workers through a SEPARATE rollup pass — so the `external`
  // below in `build.rollupOptions` does not reach it. Without this the worker
  // would ship an inlined, transformed copy of the scheduler while
  // `assert-shared-parity.sh` went on comparing the two files it knows about and
  // reporting green about bytes nobody runs. That is ADR 0001's gate quietly
  // voided by a config file, which is exactly the failure the comment above
  // describes for the page.
  worker: {
    format: "es",
    rollupOptions: {
      makeAbsoluteExternalsRelative: false,
      external: SHARED,
      output: { paths: sharedPaths },
    },
  },
  // No `public/`. The shared files live at `web/` root as symlinks into
  // `shared/`, which is what the parity manifest iterates and what `aws s3 sync`
  // follows; a second copy under `public/` would ship the same bytes from a
  // directory the manifest does not look at, which is exactly the silent loss of
  // coverage that script refuses to allow.
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // THE MAP IS HOW THE PROSE SURVIVES THE BUNDLER, and it is not optional here.
    // `shared/` compiles with `removeComments: false` because the artefact is the
    // documentation; the page cannot have that. Rollup strips every comment from
    // the chunk whether or not it minifies — measured, not assumed — so the
    // sourcemap is the only thing that puts the 1:1 commentary this file is
    // written in back in front of anyone reading the deployed page.
    sourcemap: true,
    rollupOptions: {
      // Rollup's default is `"ifRelativeSource"`: because the SOURCE specifier is
      // relative (`./schedule.js`), it turns the absolute id `paths` returns back
      // into a relative one — and emitted `../../../../../../../../../schedule.js`
      // when asked for `/schedule.js`. Measured, not guessed. `false` means "the
      // id I gave you is the id you emit".
      makeAbsoluteExternalsRelative: false,
      external: SHARED,
      output: {
        // ROOT-RELATIVE, NOT `./`, AND MATCHED ON THE BASENAME.
        //
        // The chunk is emitted to `/assets/`, so the source's `./schedule.js`
        // has to be rewritten or the browser asks for `/assets/schedule.js`.
        // Rollup does not hand this hook the specifier that was written in the
        // source: it normalises a relative external against the output
        // directory first, so a literal `{"./schedule.js": ...}` map matches
        // NOTHING and the build emits `../src/schedule.js` — a 404 that exists
        // only in the built page and only in production, because `src/` is not
        // uploaded. Measured, not guessed: that is what the first build did.
        //
        // Matching the basename is immune to which form Rollup passes.
        paths: sharedPaths,
      },
    },
  },
}));
