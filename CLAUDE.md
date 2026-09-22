# Remy dev box runtime

This package is everything that runs inside a hosted Remy dev box, as **two processes from one
package**:

- **`remy-sandbox`** (`src/index.ts` → `dist/index.js`) — the command-and-control server. Owns the
  editor's WebSocket, the file system, the LSP, process supervision, the live-preview reverse proxy,
  and home-directory snapshots. Port 4387; the LSP HTTP sidecar is on 4388.
- **`remy-tunnel`** (`src/devTunnel/cli.ts` → `dist/devTunnel/cli.js`) — the dev tunnel. Polls the
  platform for method requests, transpiles and executes them, syncs table schemas, proxies the app
  with `window.__MINDSTUDIO__` injected, and drives the sandbox-hosted headless Chrome.

The C&C spawns the tunnel as a child and they talk newline-delimited JSON over its stdin/stdout.
The tunnel used to be a separate npm package (`@mindstudio-ai/local-model-tunnel`, binary
`mindstudio-local`) installed at boot; it is not any more. Reasoning:
`youai-api/.working-docs/devbox-runtime-consolidation.md`.

## Build & run

```
npm run build        # tsc, then the browser-agent bundle, then the worker self-containment gate
npm run typecheck    # BOTH TypeScript programs — see below
npm run dev          # tsx src/index.ts — NEEDS a prior `npm run build`, see below
npm start            # node dist/index.js
```

## Things that will bite you

**`npm run dev` needs a build first.** The C&C spawns the tunnel from `dist/devTunnel/cli.js`. Under
`tsx` there is no such file — only `cli.ts` — and tsx's loader rides `process.execArgv`, so it is
not inherited by a child spawned as `node <script>`. `startTunnel` checks and fails with a message
saying so.

**The tunnel is spawned by module-relative path, never by PATH name.** `remy-tunnel` is on PATH in
the image, so a PATH lookup would work — and would be wrong. `CNC_DEV_BRANCH` builds the C&C from a
branch into `/tmp/remy-cnc-dev` and runs it from there, while `/usr/local/bin/remy-tunnel` is still
the copy baked into the image; a PATH lookup would pair a branch C&C with a released tunnel and
silently test a combination nobody asked about. Resolving off `import.meta.url` means one branch name
gets a matched pair.

**Credentials go on the child's environment, never on argv.** `ProcessManager` builds the full
command line, logs it twice, stores it as `ProcessInfo.command`, and serves that to the editor's
process list — so an `--api-key` flag is a broadcast channel. Both children (`remy-tunnel` and
`remy`) take `MINDSTUDIO_API_KEY` / `MINDSTUDIO_BASE_URL` from `env`.

**The method worker must stay a single self-contained file.**
`devTunnel/execution/executor.ts` copies the emitted `worker.js` into the *user's project tree* and
forks it from there, so its `import '@mindstudio-ai/agent'` resolves against the app's own install.
Only that one file is copied, so a relative import inside it fails at fork time with
`ERR_MODULE_NOT_FOUND` — in a container, on the method-execution path, with no build signal.
`scripts/assert-worker-standalone.mjs` runs on every `npm run build` and in `pr-checks.yml` to
prevent that. It is also why the copy is renamed `.mjs` (the app project may be `type: commonjs`)
and why it is a copy rather than a symlink (Node resolves a symlink's dependencies from its
realpath, which would defeat the whole point).

**Two TypeScript *programs*, on purpose — `tsc --noEmit` alone does not check the repo.**
`src/browserAgent/` is browser code bundled by esbuild, not emitted by tsc. The root `tsconfig.json`
excludes it and `tsconfig.browser.json` owns it, with `moduleResolution: "bundler"` (so its imports
are extensionless, unlike every other import in `src/`, which names a `.ts` file) and `types: []` (so
`@types/node` is out of scope and `process`/`Buffer` are compile errors there). `npm run typecheck`
runs both; running bare `tsc --noEmit` silently skips 6.5k lines. Adding a file under
`src/browserAgent/` needs no registration — both configs are directory-scoped.

**The browser agent is served from our own `dist`, not a CDN.** `/__mindstudio_dev__/browser-agent.js`
answers from `dist/browserAgent/index.js`, read into memory once when `DevProxy` is constructed (so a
missing build fails immediately and by name, rather than 404-ing a `<script async>` tag and surfacing
later as "browser commands return NO_BROWSER"). It used to be fetched from unpkg at runtime. Because
the bundle and the CDP code calling `window.__MINDSTUDIO_BROWSER_AGENT__` now build from one tree,
version skew between them is impossible — several comments used to hedge against it.

**`rrweb` is pinned exactly, and must stay that way.** `^2.0.0-alpha.4` admits the whole 2.x stable
line; a caret install resolves 2.1.x and silently changes the recording engine. The event format is a
cross-repo contract — the editor's rrweb player and youai-api's `common/Recordings/stitch.ts` both
read these events.

**Two TypeScript compilers, also on purpose.** `typescript` is the TS7 native compiler that builds this
package. `@typescript/typescript6` is the TS6 **JS compiler API**, a real runtime dependency, used by
`devTunnel/interfaces/schema/*` to parse an app's source and derive JSON schemas for method inputs —
TS7 does not expose that API. It is imported under its own specifier rather than aliased over
`typescript`, because an alias puts two packages that both ship a `tsc` bin in one tree and
`node_modules/.bin/tsc` becomes whichever npm linked last.

**`allowScripts` keys are exact-version.** `esbuild` appears twice (the direct dependency and
`tsx`'s pin). Its postinstall links the platform binary; without it the transpiler throws at
runtime, which in a box means every method execution fails.

**A rejected credential must not look like a crash.** `devTunnel/ipc/session-events.ts` exits **0**
on `session-expired`. The tunnel is spawned `restartOnCrash: true, maxRestarts: 5, critical: true`,
and a non-zero exit would restart it five times on a 1/2/4/8/16s backoff — `restartCount` has no
decay window — then kill the whole C&C. Restarting cannot help: the key comes from the environment,
so it would be handed the same rejected value five times in half a minute.

## Layout

```
src/
  index.ts            C&C entry (bin: remy-sandbox)
  config.ts           env → Config, for the C&C
  bootstrap/          install agent + LSP, clone, deps, git
  server/             HTTP/WS, wsHandlers/, states/, the preview proxy, /status
  processes/          ProcessManager + per-child modules: agent/, tunnel/, devServer/
  agentTools/         remy's external tools, mostly relays to tunnel commands
  lsp/                language server client + the HTTP sidecar remy calls
  fileWatcher/  projectStatus/  utils/
  devTunnel/          the tunnel (bin: remy-tunnel) — see src/devTunnel/README.md
    protocol.ts       THE description of the C&C↔tunnel wire protocol
    cli.ts  session.ts  config.ts  api.ts
    execution/  proxy/  browser/  stdin-commands/  config/  interfaces/  ipc/  logging/
  browserAgent/       BROWSER code — the in-page agent. Separate tsconfig, bundled by
                      esbuild, served by the tunnel's proxy. See its README.md.
```

## The protocol between the two halves

**`src/devTunnel/protocol.ts` is the single source of truth** — the event union, the action names,
the params and the result shapes, all imported by both sides. The producer is checked when it emits
and the consumer when it reads.

Do not restate payload shapes in prose. A hand-written mirror of this union used to live in
`src/processes/tunnel/events.ts`, and it drifted: `session-started.branch` was declared required in
three repos, never sent and never read; `platform-method-started.method` was declared required but
can be absent on the wire; `sandbox-browser-state` claimed `pid: number` while one of its emit sites
sends null. `parseJsonEvent` validates nothing beyond "has a string `event`", so nothing caught any
of it. Point at the types instead.

`src/devTunnel/README.md` covers the tunnel's own startup sequence, signals, browser agent, file
watchers and proxy configuration.

## Logs

Operational logs go to **stderr** — stdout is the protocol channel in the tunnel, and a stray
`console.log` there corrupts the stream. Levels `error` > `warn` > `info` > `debug`; the C&C has two
(`LOG_LEVEL` for the editor's log pane, `STDOUT_LOG_LEVEL` for the scraped sink, deliberately
different defaults — see `logger.ts`).

Per-process logs land in `.logs/<name>.ndjson` via `ProcessRegistry` (2 MB rotation). The tunnel also
writes:

- **`.logs/requests.ndjson`** — every method and scenario execution, with input, output, the full
  error object, captured stdout, the databases available at execution time, duration, memory stats
  and the callback token. Built for agent consumption; keeps the most recent 300 entries.
- **`.logs/browser.ndjson`** — console output, JS errors with stacks, every fetch/XHR with status
  and duration, and click interactions, from the browser agent injected into every HTML response.

```bash
tail -5 .logs/requests.ndjson | jq .
grep '"success":false' .logs/requests.ndjson | jq .
```

## Conventions

- Every relative import names the `.ts` file that exists; `rewriteRelativeImportExtensions` emits
  `.js`. Two strings are **runtime paths, not import specifiers**, and must keep their emitted
  extension: `'../../devTunnel/cli.js'` in `processes/tunnel/index.ts` and `'./worker.js'` in
  `devTunnel/execution/executor.ts`. Both carry a comment saying so.
- `declaration` is off: the extension rewrite does not apply to declaration emit, and this is a
  bin-only package with no library consumers.
- `verbatimModuleSyntax` is on, which is what keeps the worker's one sibling import type-only.
- Prettier with `prettier-plugin-curly`, enforced by a husky pre-commit hook.
- CI (`pr-checks.yml`) runs `typecheck` **and `build`** — the build is what carries the worker gate.
  Merging to `main` publishes if `package.json`'s version is above what is on npm.
