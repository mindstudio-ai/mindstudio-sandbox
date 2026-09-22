# The dev tunnel

`remy-tunnel`, this package's second bin. The C&C server spawns it as a child process and drives it
over newline-delimited JSON on its stdin/stdout. It polls the platform for method execution
requests, transpiles and runs them, syncs table schemas, proxies the app with
`window.__MINDSTUDIO__` injected, and supervises the sandbox-hosted headless Chrome.

Headless is the only mode. It was once a separate npm package with an interactive TUI and a
`--headless` flag; the TUI stayed behind in `mindstudio-local-model-tunnel` with the rest of the
laptop story, and the flag is gone.

**The wire protocol is `./protocol.ts`, not this file.** Event names, command names, params and
result shapes all live there as types that both halves import. Restating them in prose is precisely
how the C&C's old hand-written mirror came to declare three fields that were never sent. This
document covers the things types cannot: sequence, lifecycle, and the surrounding machinery.

```bash
# how the C&C invokes it (processes/tunnel/index.ts) — credentials on the environment
MINDSTUDIO_API_KEY=… MINDSTUDIO_BASE_URL=… USER_ID=… \
  node dist/devTunnel/cli.js --port 5173 --sandbox-browser --log-level info
```

| Flag | Meaning |
|---|---|
| `--port <n>` | The dev server to proxy. Falls back to `devPort` in the web interface config; with neither, the proxy does not start and only method execution works |
| `--proxy-port <n>` | Preferred port for the proxy. Defaults to a stable port derived from the app id |
| `--sandbox-browser` | Launch and supervise the box's headless Chrome as a WS client |
| `--log-level <lvl>` | `error` \| `warn` \| `info` \| `debug`. Default `info` |

The proxy binds `127.0.0.1` unconditionally. Nothing outside the container reaches this port — a box
exposes exactly one, the C&C's 4387 — and every consumer of this one is a sibling process on
loopback: the C&C reverse-proxies preview and HMR traffic to it, and the box's headless Chrome loads
it directly. See the comment on `BIND_ADDRESS` in `session.ts`.

`MINDSTUDIO_API_KEY` and `MINDSTUDIO_BASE_URL` are required; `USER_ID` and `DB_WS_URL` are optional,
and `DB_WS_URL`'s absence is meaningful (see `config.ts` — it selects the worker's fetch transport,
and inventing a default is how a box ends up making database calls its token is not valid for).

## Startup sequence

1. `initConfig()` reads the environment. Missing credentials fail here, loudly.
2. Read `mindstudio.json`; validate config and `appId`.
3. Emit `session-starting`.
4. Start the platform session — registers methods and data sources, gets the session token and
   client context.
5. Sync table schemas if any tables are declared → `schema-sync-completed`.
6. Start the proxy if a dev port resolved, injecting `window.__MINDSTUDIO__` into HTML.
7. Optionally launch the sandbox browser, which connects back to the proxy as a WS client.
8. Emit `session-started` with the session, the proxy URL, and the app's roles and scenarios.
9. Begin polling the platform for method execution requests.
10. Watch `mindstudio.json`, every interface JSON it references, and the declared table sources.

A boot that cannot find a valid `mindstudio.json` retries five times with backoff, then emits
`degraded-state` and keeps retrying on a 15s timer until the config appears —
`degraded-state-resolved` when it does.

## Stdin commands

Every command carries a `requestId`. Responses echo it with `status: "started"` (an optional
intermediate ack) then `status: "completed"`. System events — session lifecycle, connection health,
browser state — carry no `requestId`, which is how the C&C tells them apart.

The seventeen action names, their params and their results are `TunnelAction`,
`TunnelCommandParams` and `TunnelCommandResult` in `./protocol.ts`; the failure codes are
`ERROR_CODES` in the same file. Read those rather than a table here.

Two behaviours worth knowing that the types do not express:

- **A replay export owns the browser.** While one is pending or running, `browser`,
  `screenshotFullPage`, `screenshotViewport` and `renderHtml` fail immediately with `BUSY` rather
  than queueing — a queued command would outlive the caller's timer and then run orphaned.
- **`run-method` accepts an auth override.** `roles` and `userId` scope a single execution without
  touching session state. `userId: "testUser"` is a reserved sentinel resolving to the platform's
  dev-bypass user (found or created by email `remy@mindstudio.ai`, or phone `+15555555555` for
  phone-auth apps; the platform skips OTP for both), cached for the session. It is how an agent
  invokes an auth-gated method without first seeding a user through a scenario.

## File watchers

No polling and no commands — changes are picked up automatically. Both watchers handle atomic
write-then-rename correctly.

| What | Action |
|---|---|
| `mindstudio.json` and every interface JSON it references | Full session teardown and restart, so new methods, scenarios, roles and tables are picked up. Validates *before* tearing down, so a corrupt mid-write file does not kill a live session. Emits `config-changed` → `session-starting` → `session-started` |
| The one exception: `web.json`'s `defaultPreviewMode` | Hot-applied to the sandbox browser with no restart, so rrweb continuity and cookies survive the swap |
| Declared table source files | Re-read and schema-sync, no session restart. `schema-sync-started` → `schema-sync-completed` |

## Signals

`SIGTERM` and `SIGINT` both shut down gracefully: `session-stopping` → teardown → `session-stopped`
→ exit 0.

An expired or rejected credential emits `session-expired` and **also exits 0**. That is deliberate
and load-bearing — see the note in `ipc/session-events.ts`. The C&C supervises this process with
`restartOnCrash` and `critical`, so a non-zero exit there would burn the process's five lifetime
restarts on a credential no restart can fix, and then take the whole box down.

## The proxy

Sits in front of the dev server. HTML responses are buffered and get `window.__MINDSTUDIO__`
injected before `</head>`; everything else — JS, CSS, images, WebSocket upgrades for HMR — is
forwarded unchanged. CORS and Private Network Access headers are added so the preview works inside
the editor's iframe, and caching is disabled.

The injected object is the same shape the CDN injects in production, which is what lets interface
code run unmodified in both. The proxy port is reported in `session-started`.

The proxy also serves `/__mindstudio_dev__/ws` for the browser agent and
`/__mindstudio_dev__/render` for replay video export.

## The browser agent

The proxy injects a `<script>` tag into every HTML response loading the browser agent, which connects
back over WebSocket. Its source is `src/browserAgent/` in this repo — see that directory's README.

**Multi-client.** Several browsers can attach at once — the editor's iframe, a standalone tab, a
phone. Broadcasts (reload) go to all of them; command-and-control goes to one preferred client,
favouring `mode=iframe`, and to the sandbox-hosted Chrome when `--sandbox-browser` is on.

**Log capture** is always on and writes `.logs/browser.ndjson`: console output, uncaught errors and
unhandled rejections with stacks, every fetch and XHR with status and duration (and the response
body on failures), and click interactions with the element's role, name and text.

**DOM snapshots** are a compact accessibility tree rather than markup: semantic roles and accessible
names instead of CSS classes (so styled-components and CSS-in-JS do not matter), stable `[ref=eN]`
identifiers on interactive elements, `cursor: pointer` elements detected and included, form values
and placeholders shown, hidden elements skipped and empty wrappers collapsed. It waits for network
idle first — 200ms settle, 5s cap.

**Where the bundle comes from.** `/__mindstudio_dev__/browser-agent.js`, served from this package's
own `dist/browserAgent/index.js` and read into memory once when `DevProxy` is constructed. It used to
be fetched from `https://unpkg.com/@mindstudio-ai/browser-agent/dist/index.js` — unversioned,
third-party, at runtime, on the critical path of all automation and all recording in every box. There
is no URL override any more: the agent is built from source here, so `npm run build` is how you
change what the page loads, and the page-side API cannot drift from the code that drives it.

## What the C&C is responsible for

- Starting and supervising the dev server (Vite, Next, whatever the app declares).
- Minting `requestId`s and correlating responses.
- Reading `mindstudio.json` itself for scenario and role lists — static config, not runtime state.
- Relaying events to the editor, and its own logging.
