# Browser agent

The in-page half of dev automation. Injected into every dev-preview HTML response by the tunnel's
proxy, it captures console/network/error logs, walks the DOM into a compact accessibility tree,
executes click/type/select commands, and records rrweb replays.

This is browser code — the only subtree in this repo that is. It does not run in Node, is not emitted
by `tsc`, and is not part of the root TypeScript program.

## How it gets into the page

```
DevProxy.injectScripts()  ──▶  <script async src="/__mindstudio_dev__/browser-agent.js">
                                          │
dist/browserAgent/index.js  ◀─────────────┘   served from memory, read once at construction
       ▲
scripts/build-browser-agent.mjs   esbuild → one minified IIFE
       ▲
src/browserAgent/index.ts
```

It used to be a separate package, `@mindstudio-ai/browser-agent`, fetched at runtime from
`https://unpkg.com/@mindstudio-ai/browser-agent/dist/index.js` — unversioned, third-party, on the
critical path of all automation and all recording in every box. Nothing ever imported it: the tunnel
injected a URL and called a global, so it was a served artifact rather than a dependency. It now
builds from this directory, which means the page-side API and the code driving it over CDP ship as
one unit and cannot drift apart.

There is no URL override. `npm run build` is how you change what the page loads.

## Build and typecheck

```bash
npm run build       # includes scripts/build-browser-agent.mjs
npm run typecheck   # runs BOTH programs — the root one and this one
```

Two things make this subtree work differently from everything else here, both in
`tsconfig.browser.json`:

- **`moduleResolution: "bundler"`**, so relative imports are extensionless. Every import elsewhere in
  `src/` names a `.ts` file because the root program emits real Node ESM and needs
  `rewriteRelativeImportExtensions`. This one emits nothing — esbuild bundles it — so a specifier
  only has to resolve at build time. The root `tsconfig.json` excludes this directory.
- **`types: []`**, so `@types/node` is not in scope and `process`, `Buffer` and `__dirname` are
  compile errors. The subtree is Node-free and this is what keeps it that way.

`rrweb` and `@zumer/snapdom` are the only external imports. They are **devDependencies** — inlined
into the bundle, so the published package does not carry them at runtime — and **pinned exactly**.
The caret range this code shipped with (`^2.0.0-alpha.4`) admits the whole rrweb 2.x stable line, and
the replay event format is a cross-repo contract: the editor's rrweb player and youai-api's
`common/Recordings/stitch.ts` both read these events. An rrweb upgrade needs to be its own change.

## Communication

A persistent WebSocket to `/__mindstudio_dev__/ws` (`commands/ws-client.ts`), auto-reconnecting with
exponential backoff. It carries commands inbound and results plus log batches outbound. The proxy
supports several concurrent clients — the editor's iframe, a standalone tab, a phone, the
sandbox-owned headless Chrome — and routes command-and-control to one preferred client.

`/__mindstudio_dev__/logs` remains as an HTTP fallback, used by `navigator.sendBeacon` on unload when
the socket is already closing.

Two other channels:

- **postMessage** with the parent editor on channel `mindstudio-browser-agent`
  (`iframe-bridge.ts`) — a single listener that fans out to the modules. The editor knows only this
  channel name; it imports nothing from here.
- **`window.__MINDSTUDIO_BROWSER_AGENT__`** (`index.ts`), the handle the tunnel calls over CDP via
  `page.evaluate`. Exposes `takeSnapshot`, `takeSnapshotSync`, `getRefMap`, `executeSteps`,
  `resolveElement`, `computeStyleMap`, `capturePageImage`, `hideCursor`, `restoreCursor`.

## State and idempotency

All mutable state lives on `window.__ms` behind `getState()` (`state.ts`) so it survives HMR module
replacement, and `index.ts` guards the whole init block on
`window.__MINDSTUDIO_BROWSER_AGENT__` already existing. Every monkey-patch is separately guarded
against stacking via `__ms_patched` flags on the patched object. The script is safe to load
repeatedly — HMR, SPA navigation, iframe reload.

A hard navigation destroys `window.__ms`, which is deliberate: it starts a fresh rrweb run.

## Modules

| Path | What it does |
|---|---|
| `index.ts` | Entry point. Idempotency guard, exposes the global API, fixed init order (`iframe-bridge` before `cursor`/`touch`, which read query params that gate their init) |
| `state.ts` | All mutable state, namespaced on `window.__ms` so it survives HMR |
| `transport.ts` | Log buffer; 2s batch flush, immediate on errors, `sendBeacon` on unload |
| `network-idle.ts` | In-flight fetch/XHR count, so snapshots can wait for the page to settle |
| `utils.ts` | Serialization, element description, scroll-container lookup, sleep |
| `capture/console.ts` | `console.*` override, calls originals through |
| `capture/errors.ts` | `error` and `unhandledrejection` listeners, with stacks |
| `capture/network.ts` | `fetch` patch — logs and feeds the idle tracker |
| `capture/xhr.ts` | `XMLHttpRequest` patch, same |
| `capture/interactions.ts` | Capture-phase click listener with accessible descriptions |
| `snapshot/walker.ts` | The DOM walker; `takeSnapshot()`, `describeTarget()` |
| `snapshot/roles.ts` | Implicit ARIA role mapping, `cursor: pointer` detection |
| `snapshot/name.ts` | Accessible name computation |
| `commands/ws-client.ts` | The WebSocket, reconnect, mode and sandbox-browser detection |
| `commands/executor.ts` | Runs a step batch, captures logs, handles pending navigation |
| `commands/actions.ts` | `click`, `type`, `select`, `wait`, `evaluate` |
| `commands/resolve.ts` | Element resolution by ref, text, role, label or selector |
| `commands/style-map.ts` | Compact text description of rendered visual state for LLMs — resolved font sizes, line counts, overflow, overlaps |
| `commands/screenshot.ts` | SnapDOM viewport capture for the user-facing annotation flow only. **Not** the agent screenshot path, which is CDP in `src/devTunnel/browser/screenshot.ts` |
| `cursor/cursor.ts` | The animated pink "Remy" cursor, with a hide/restore state machine for captures |
| `cursor/touch.ts` | Mobile-preview touch simulation; drag scrolls, short clicks pass through |
| `recording/session-recorder.ts` | One long-lived rrweb recording per document, so node IDs stay continuous across commands — first flush has Meta + FullSnapshot, later ones are incremental only |
| `mirror/record.ts` | rrweb streaming to a phone mirror viewer, gated on `?mirror=true` |
| `navigation.ts` | Reports SPA route changes to the editor, which cannot read the cross-origin iframe's `location` |
| `fonts.ts` | Rewrites cross-origin font stylesheets through `/__mindstudio_dev__/font-proxy` so SnapDOM can read `@font-face` via CSSOM |
| `iframe-bridge.ts` | The single postMessage listener, routing to modules |
| `auth-creds/` | Dev-mode auth widget: detects auth-shaped inputs and one-click fills the platform's dev-bypass credentials, chaining the OTP step |

## Modes

Behaviour depends on how the page was loaded:

- **iframe** (`window.parent !== window`) — the editor's preview. The cursor and touch simulation
  only run here.
- **standalone** — a plain tab.
- **sandbox browser** — the tunnel's launcher navigates Chrome to `?ms_sandbox=1`, which is latched
  into `sessionStorage` so it survives same-origin reloads. The proxy registers this client as
  `mode=headless` and blocks readiness on its WS hello.

## See also

- `spec.md` — the original design spec. Rationale, not mechanics; read its header first.
- `../devTunnel/README.md` — the other half: the proxy that injects this, and the WS server.
