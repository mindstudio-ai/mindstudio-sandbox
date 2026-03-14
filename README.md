# MindStudio Sandbox — C&C Server

The command & control server that runs inside hosted MindStudio sandbox
containers. Manages the dev environment, exposes a WebSocket API for
the web editor, and reverse-proxies the live preview.

## Architecture

Single port (4387) serves everything:

```
Browser
  ├── wss://host/ws?token=...   → C&C WebSocket (editor control)
  ├── wss://host/lsp            → TypeScript language server (LSP over JSON-RPC)
  ├── https://host/health       → health check (public)
  ├── https://host/*            → reverse proxy → dev server (preview)
  └── wss://host/*              → reverse proxy → dev server (HMR)
```

Internally, port 4388 runs the LSP HTTP sidecar for the remy agent.

Inside the container, the C&C server manages:
- **Dev server** (Vite / webpack / etc.) — frontend with HMR
- **Dev tunnel** (`mindstudio-local --headless`) — method execution, platform sync
- **Remy agent** (`remy --headless`) — AI coding agent
- **File watcher** — broadcasts filesystem changes to connected clients
- **TypeScript language server** — shared between Monaco editor and remy

### Process Registry

Every process — bootstrap tasks, long-lived services, shell commands,
and system logs — is tracked in a unified process registry with:

- Lifecycle metadata (state, PID, start/end time, exit code, restart history)
- Per-process log buffers (1000 lines each)
- State-change events broadcast to all connected clients

Process types: `service` (long-lived), `task` (bootstrap one-shot),
`shell` (ad-hoc commands), `system` (C&C server logs).

### Logging

All logging goes through a centralized logger with levels (`debug`,
`info`, `warn`, `error`). Set `LOG_LEVEL` env var to control verbosity
(default: `info`). Logs flow into the process registry and are
broadcast to WebSocket clients as batched `processOutput` events.

## Connecting from the Frontend

### 1. Open a WebSocket

```typescript
const ws = new WebSocket(`wss://${cncDomain}/ws?token=${sandboxToken}`);
```

`cncDomain` and `sandboxToken` come from the platform API when a sandbox
session is started.

### 2. Send requests

Every request has a `requestId` (client-generated), an `action`, and
`params`. The server responds with the same `requestId`.

```typescript
function send(ws, action, params) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    function handler(event) {
      const msg = JSON.parse(event.data);
      if (msg.requestId === requestId) {
        ws.removeEventListener('message', handler);
        resolve(msg);
      }
    }
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ requestId, action, params }));
  });
}
```

### 3. Handle the initial frame

The first message on connect is an `init` event with everything you
need to bootstrap the UI — no round-trips required:

```json
{
  "event": "init",
  "status": "ready",
  "previewAvailable": true,
  "app": {
    "appId": "7c4d99f7-...",
    "name": "Haiku Generator",
    "methods": [{ "id": "generate-haiku", "name": "Generate Haiku", "path": "...", "export": "..." }],
    "tables": [{ "path": "...", "export": "Haikus" }],
    "interfaces": [{ "type": "web", "path": "dist/interfaces/web/web.json" }]
  },
  "fileTree": [
    {
      "name": "dist", "path": "dist", "type": "directory", "size": 160, "modified": "...",
      "children": [...]
    },
    { "name": "mindstudio.json", "path": "mindstudio.json", "type": "file", "size": 1073, "modified": "..." }
  ],
  "chatHistory": [
    { "role": "user", "content": "add a delete method for haikus" },
    { "role": "assistant", "content": "I'll update the table schema.", "toolCalls": [...] }
  ],
  "processes": [
    { "name": "devServer", "type": "service", "state": "running", "pid": 12345, "startedAt": 1710000000000, ... },
    { "name": "tunnel", "type": "service", "state": "running", "pid": 12346, ... },
    { "name": "agent", "type": "service", "state": "running", "pid": 12347, ... },
    { "name": "bootstrap:npm-install", "type": "task", "state": "completed", "exitCode": 0, "duration": 4523, ... }
  ],
  "outputLog": [
    { "process": "system", "stream": "stdout", "line": "[cnc] Server listening on port 4387", "ts": 1710000000000 },
    { "process": "devServer", "stream": "stdout", "line": "VITE v7.3.1 ready in 320ms", "ts": 1710000000100 }
  ]
}
```

| Field | Contents |
|-------|----------|
| `status` | Server status: `"bootstrapping"`, `"ready"`, or `"error"` |
| `previewAvailable` | Whether the preview proxy is ready |
| `app` | Parsed `mindstudio.json` — app name, methods, tables, interfaces |
| `fileTree` | Recursive file tree (3 levels deep), directories first, alphabetical. Excludes `node_modules`, `.git`, `.vite`. |
| `chatHistory` | Agent conversation history fetched from remy. Empty array if agent isn't running or no messages yet. This is the raw LLM-level message format from remy's session. |
| `processes` | All tracked processes with lifecycle metadata (see Process Registry above) |
| `outputLog` | Merged log across all processes, sorted by timestamp (last 5000 lines) |

Each tree entry has `name`, `path` (relative), `type`, `size`, `modified`,
and `children` (for directories within the depth limit). Use `listDir`
to lazily load deeper levels.

### 4. Listen for pushed events

The server broadcasts events that have an `event` field (no `requestId`).
Filter these from responses:

```typescript
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.event) {
    // Pushed event — handle by type
  } else if (msg.requestId) {
    // Response to a request
  }
});
```

**Note:** `processOutput` and `processStateChanged` events are batched —
they arrive as `{ event: "...", batch: [...] }` with an array of entries,
flushed every 100ms. All other events are sent individually.

## Actions

### `listDir`

List directory contents.

```json
{ "requestId": "...", "action": "listDir", "params": { "path": "." } }
```

Response:
```json
{
  "requestId": "...",
  "success": true,
  "data": {
    "entries": [
      { "name": "src", "type": "directory", "size": 160, "modified": "2026-03-13T..." },
      { "name": "package.json", "type": "file", "size": 432, "modified": "2026-03-13T..." }
    ]
  }
}
```

### `readFile`

Read file contents. Text files return `encoding: "utf-8"`, binary files
return base64.

```json
{ "requestId": "...", "action": "readFile", "params": { "path": "src/App.tsx" } }
```

Response:
```json
{
  "requestId": "...",
  "success": true,
  "data": {
    "content": "import React from 'react';\n...",
    "encoding": "utf-8"
  }
}
```

### `writeFile`

Write or create a file. Parent directories are created automatically.

```json
{ "requestId": "...", "action": "writeFile", "params": { "path": "src/App.tsx", "content": "..." } }
```

### `deleteFile`

Delete a file or directory (recursive).

```json
{ "requestId": "...", "action": "deleteFile", "params": { "path": "src/old.ts" } }
```

### `renameFile`

Move or rename a file.

```json
{ "requestId": "...", "action": "renameFile", "params": { "oldPath": "src/a.ts", "newPath": "src/b.ts" } }
```

### `search`

Search file contents using ripgrep (falls back to grep).

```json
{
  "requestId": "...",
  "action": "search",
  "params": {
    "query": "useState",
    "glob": "*.tsx",
    "caseSensitive": false,
    "maxResults": 50
  }
}
```

`glob` and `caseSensitive` are optional. `maxResults` defaults to 100.
Results always exclude `node_modules/`, `.git/`, and `.vite/`.

### `shell`

Run an arbitrary shell command. Tracked as a `shell` process in the
registry (visible in `getProcesses`, auto-removed after 5 minutes).

```json
{
  "requestId": "...",
  "action": "shell",
  "params": {
    "command": "git status --porcelain",
    "timeout": 10000
  }
}
```

Response:
```json
{
  "requestId": "...",
  "success": true,
  "data": {
    "exitCode": 0,
    "stdout": " M src/App.tsx\n",
    "stderr": ""
  }
}
```

`timeout` is in milliseconds, defaults to 30000. `cwd` is optional
(relative to workspace root). While the command runs, stdout/stderr
lines are streamed as batched `processOutput` events.

### `agentMessage`

Send a message to the AI coding agent. Response is an immediate ack —
the agent's output streams as pushed events (see below).

```json
{ "requestId": "...", "action": "agentMessage", "params": { "text": "add a delete method for haikus" } }
```

Then listen for `agentThinking`, `agentText`, `agentToolStart`,
`agentToolDone`, and `agentTurnDone` events.

### `agentCancel`

Cancel the current agent turn. Aborts the in-progress response
gracefully — partial output is saved to the session.

```json
{ "requestId": "...", "action": "agentCancel", "params": {} }
```

Listen for `agentTurnCancelled` to confirm.

### `agentClear`

Clear the agent's conversation history and start a fresh session.

```json
{ "requestId": "...", "action": "agentClear", "params": {} }
```

Listen for `agentSessionCleared` to confirm.

### `getProcesses`

Get all tracked processes with their current state and metadata.

```json
{ "requestId": "...", "action": "getProcesses", "params": {} }
```

Response:
```json
{
  "requestId": "...",
  "success": true,
  "data": {
    "processes": [
      {
        "name": "devServer",
        "type": "service",
        "command": "npm run dev",
        "state": "running",
        "startedAt": 1710000000000,
        "endedAt": null,
        "duration": null,
        "exitCode": null,
        "signal": null,
        "restartCount": 0,
        "restartHistory": [],
        "pid": 12345
      }
    ]
  }
}
```

### `getProcessLog`

Get the per-process log buffer (up to 1000 lines).

```json
{ "requestId": "...", "action": "getProcessLog", "params": { "name": "tunnel" } }
```

Response:
```json
{
  "requestId": "...",
  "success": true,
  "data": {
    "log": [
      { "stream": "stdout", "line": "{\"event\":\"session-started\",...}", "ts": 1710000000000 },
      { "stream": "stderr", "line": "[INFO] api POST /dev/manage/start → 200 (142ms)", "ts": 1710000000001 }
    ]
  }
}
```

### `tunnelRunScenario`

Run a scenario by ID. Truncates all tables, executes the seed function,
and applies the scenario's roles. Listen for `tunnelEvent` with
`scenario-start` and `scenario-complete` events.

```json
{ "requestId": "...", "action": "tunnelRunScenario", "params": { "scenarioId": "sample-haikus" } }
```

### `tunnelSyncSchema`

Re-sync table definitions from disk (re-reads `mindstudio.json`).
Listen for `tunnelEvent` with `schema-synced`.

```json
{ "requestId": "...", "action": "tunnelSyncSchema", "params": {} }
```

### `tunnelListScenarios`

Request the current list of scenarios (re-reads `mindstudio.json`).
Listen for `tunnelEvent` with `scenarios-list`.

```json
{ "requestId": "...", "action": "tunnelListScenarios", "params": {} }
```

### `tunnelImpersonate`

Set a role override. Subsequent method executions will use these roles
instead of the session's default. Listen for `tunnelEvent` with
`impersonated`.

```json
{ "requestId": "...", "action": "tunnelImpersonate", "params": { "roles": ["ap", "admin"] } }
```

### `tunnelClearImpersonation`

Clear the role override, reverting to the session's default roles.
Listen for `tunnelEvent` with `impersonated` (roles will be `null`).

```json
{ "requestId": "...", "action": "tunnelClearImpersonation", "params": {} }
```

### `tunnelListRoles`

Request the available roles from `mindstudio.json`. Listen for
`tunnelEvent` with `roles-list`.

```json
{ "requestId": "...", "action": "tunnelListRoles", "params": {} }
```

## Pushed Events

Events are broadcast to all connected clients. They have an `event`
field and no `requestId`.

### `processOutput` (batched)

Lines of stdout/stderr from tracked processes. Delivered as batched
arrays every 100ms.

```json
{
  "event": "processOutput",
  "batch": [
    { "process": "devServer", "stream": "stdout", "line": "VITE v7.3.1 ready in 320ms", "ts": 1710000000000 },
    { "process": "system", "stream": "stdout", "line": "[cnc] Bootstrap complete", "ts": 1710000000005 }
  ]
}
```

`process` can be any registered name: `devServer`, `tunnel`, `agent`,
`system` (C&C server logs), `bootstrap:*` (task names), `shell:*`
(ad-hoc command IDs).

### `processStateChanged` (batched)

A process transitioned state. Delivered as batched arrays.

```json
{
  "event": "processStateChanged",
  "batch": [
    {
      "name": "devServer",
      "type": "service",
      "prevState": "starting",
      "state": "running",
      "pid": 12345,
      "restartCount": 0,
      "timestamp": 1710000000000
    }
  ]
}
```

States: `starting`, `running`, `crashed`, `stopped`, `completed`.

### `fileChanged`

A file was created, modified, or deleted outside of the WebSocket
(e.g., by git, npm install, or the dev server). Not fired for changes
made via `writeFile` / `deleteFile` / `renameFile` actions.

```json
{ "event": "fileChanged", "path": "src/App.tsx", "changeType": "modified" }
```

`changeType` is `"created"`, `"modified"`, or `"deleted"`.

### `tunnelEvent`

A parsed JSON event from the dev tunnel's headless output. All tunnel
stdout events are forwarded as-is with `event: "tunnelEvent"` added.

```json
{ "event": "tunnelEvent", "event": "session-started", "sessionId": "...", "proxyPort": 3835, "proxyUrl": "http://...", "scenarios": [...] }
```

**Lifecycle events:**
- `starting` — tunnel initializing (`appId`, `name`)
- `session-started` — platform session active (`sessionId`, `releaseId`, `branch`, `proxyPort`, `proxyUrl`, `webInterfaceUrl`, `scenarios`)
- `stopping` — graceful shutdown initiated
- `stopped` — cleanup complete, process exiting

**Schema & data events:**
- `schema-synced` — table schemas synced (`created`, `altered`, `errors`)
- `scenario-start` — scenario being applied (`id`, `name`)
- `scenario-complete` — scenario finished (`id`, `success`, `duration`, `roles`)
- `scenarios-list` — response to `tunnelListScenarios` (`scenarios`)

**Method execution events:**
- `method-start` — method execution started (`id`, `method`)
- `method-complete` — method execution finished (`id`, `success`, `duration`, `error?`)

**Role impersonation events:**
- `impersonated` — role override applied (`roles` array) or cleared (`roles: null`)
- `roles-list` — response to `tunnelListRoles` (`roles: [{ id, name }]`)

**Connection events:**
- `connection-warning` — lost platform connection (`message`)
- `connection-restored` — reconnected
- `session-expired` — platform expired the session (tunnel exits with code 1)

**Error events:**
- `error` — fatal tunnel error (`message`)

**Scenario discovery:** The `session-started` event includes a
`scenarios` array with `{ id, name, description, roles }` for each
available scenario. Use this to populate a scenario picker UI. Call
`tunnelListScenarios` to refresh if `mindstudio.json` changes.

**Role impersonation:** Use `tunnelListRoles` to get available roles,
then `tunnelImpersonate` to set overrides. Method executions will run
with the impersonated roles until `tunnelClearImpersonation` is called.
The `scenario-complete` event also returns the roles applied by that
scenario.

### `bootstrapProgress`

Status updates during sandbox bootstrap.

```json
{ "event": "bootstrapProgress", "step": "installDeps", "message": "Installing dependencies..." }
```

Steps in order: `installTunnel`, `installAgent`, `installLsp`, `cloneApp`,
`installDeps`, `devServer`, `tunnel`, `agent`, `ready`, or `error`.

### Agent Events

These stream while the agent is processing a message (after
`agentMessage` action). They map 1:1 from remy's headless protocol.

| Event | Fields | Description |
|-------|--------|-------------|
| `agentReady` | | Agent process initialized and ready for messages |
| `agentThinking` | `text` | Agent's internal reasoning (streaming chunks) |
| `agentText` | `text` | Agent's visible response text (streaming chunks) |
| `agentToolStart` | `id`, `name`, `input` | Agent started executing a tool |
| `agentToolDone` | `id`, `name`, `result`, `isError` | Agent tool execution completed |
| `agentTurnDone` | | Agent finished responding to a message |
| `agentTurnCancelled` | | Agent turn was cancelled (via `agentCancel`) |
| `agentError` | `error` | Agent encountered an error |
| `agentSessionRestored` | `messageCount` | Agent restored a previous session on startup |
| `agentSessionCleared` | | Agent session was cleared (via `agentClear`) |

## LSP HTTP Sidecar (port 4388)

An internal HTTP API that wraps the TypeScript language server for the
remy agent. Same language server instance as Monaco — shared via the
LspClient multiplexer.

All endpoints accept POST with JSON body. File paths are relative to
the workspace root. Line/column numbers are 1-indexed.

| Endpoint | Request | Response |
|----------|---------|----------|
| `/diagnostics` | `{ file }` | `{ diagnostics: [{ file, line, column, severity, message, code }] }` |
| `/definition` | `{ file, line, column }` | `{ definitions: [{ file, line, column }] }` |
| `/references` | `{ file, line, column }` | `{ references: [{ file, line, column }] }` |
| `/hover` | `{ file, line, column }` | `{ type, documentation }` |
| `/symbols` | `{ file }` | `{ symbols: [{ name, kind, line }] }` |

The `/diagnostics` endpoint waits up to 2s for the language server to
push diagnostics after opening/updating the file. File changes from
the file watcher automatically sync to the language server.

See `LSP-FRONTEND-SPEC.md` for Monaco WebSocket integration.

## Live Preview

The preview iframe points at the same domain as the C&C server, but
any path other than `/ws`, `/lsp`, and `/health`:

```html
<iframe src={`https://${cncDomain}/`} />
```

This is reverse-proxied to the dev server (via the tunnel proxy, which
injects `window.__MINDSTUDIO__` for the frontend SDK). The preview
supports HMR — edits to files trigger hot reload automatically.

The preview is available once the tunnel emits `session-started` (watch
for the `tunnelEvent` pushed event). Before that, requests return a
503 "Preview starting..." page.

## Scenarios & Roles

MindStudio Apps v2 have **roles** (app-level access control) and
**scenarios** (seed scripts that set up the dev database into a specific
state). Both are declared in `mindstudio.json` and managed through the
dev tunnel.

### Roles

Roles are simple string identifiers (e.g. `"admin"`, `"ap"`,
`"requester"`) that control what a user can see and do within an app.
Methods check roles at runtime via `auth.requireRole()` and
`auth.hasRole()` from the `@mindstudio-ai/agent` SDK.

During development, **role impersonation** lets you see the app from
any role's perspective without switching accounts. Use
`tunnelImpersonate` to set role overrides — subsequent method executions
will run with those roles. Use `tunnelClearImpersonation` to revert.
Use `tunnelListRoles` to discover available roles.

### Scenarios

Scenarios solve the problem of testing role-based, stateful UIs. Instead
of manually creating data through the app every time, you run a scenario
and get a repeatable, well-defined starting point.

A scenario is a TypeScript function that seeds the database using the
same `@mindstudio-ai/agent` SDK that methods use (`db.push()`, etc.).
Each scenario declares which roles to impersonate after seeding, so you
immediately see the app from the right perspective.

**Running a scenario** (via `tunnelRunScenario`) does three things:
1. **Truncate** — clears all tables (blank canvas)
2. **Seed** — executes the scenario function (creates data)
3. **Impersonate** — sets the scenario's roles

Scenarios are declared in `mindstudio.json`:

```json
{
  "scenarios": [
    {
      "id": "ap-overdue-invoices",
      "name": "AP: Overdue Invoices",
      "description": "AP user with two invoices past due date",
      "path": "dist/methods/.scenarios/apOverdueInvoices.ts",
      "export": "apOverdueInvoices",
      "roles": ["ap"]
    }
  ]
}
```

The `session-started` tunnel event includes the full scenario list for
populating a picker UI. Use `tunnelListScenarios` to refresh if the
manifest changes.

**Use cases:** testing role-based UI visibility, demo data for
stakeholders, deterministic starting points for development, visual
regression testing across roles and data states.

## Health Check

```
GET /health
```

Returns:
```json
{ "status": "bootstrapping", "proxyTarget": null }
```

`status` is `"bootstrapping"`, `"ready"`, or `"error"`.
`proxyTarget` is the tunnel proxy port (number) once available, or `null`.

## Error Handling

Failed requests return:
```json
{ "requestId": "...", "success": false, "error": "Path escapes workspace" }
```

All file paths are relative to the workspace root. Paths that try to
escape the workspace (e.g., `../../etc/passwd`) are rejected.

## Environment Variables

Required to start the server:

| Var | Purpose |
|-----|---------|
| `GIT_REPO_URL` | App git repo to clone |
| `API_KEY` | Developer's MindStudio API key (for tunnel + agent) |
| `USER_ID` | Developer's user ID (for tunnel) |
| `API_BASE_URL` | Platform API URL (default: `https://api.mindstudio.ai`) |
| `WORKSPACE_DIR` | App workspace path (default: `/home/vercel-sandbox/workspace`) |
| `PORT` | Server port (default: `4387`) |
| `SANDBOX_TOKEN` | WebSocket auth token (optional, no auth if unset) |
| `LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error` (default: `info`) |

## Development

```bash
# Install dependencies
npm install

# Run against the example app
GIT_REPO_URL=test API_KEY=test USER_ID=test \
  WORKSPACE_DIR=./example PORT=4387 \
  npx tsx src/index.ts

# Type-check
npx tsc --noEmit

# Build
npm run build
```

The `example/` directory contains a sample MindStudio app (Haiku
Generator) for local testing.

## Project Structure

```
src/
  index.ts              — entry point, orchestrates bootstrap + services
  config.ts             — environment variable parsing
  types.ts              — shared TypeScript types
  logger.ts             — centralized logger with levels + onLog hook
  state.ts              — persistent state (process snapshots to disk)
  bootstrap.ts          — sync install/clone/build commands
  server/
    ws-server.ts        — HTTP + WebSocket server, actions, init frame
    broadcast-batcher.ts — batched WS event delivery (100ms flush)
    handlers/
      filesystem.ts     — file operations (listDir, readFile, writeFile, etc.)
      search.ts         — ripgrep/grep search
      shell.ts          — shell command execution
  lsp/
    client.ts           — language server JSON-RPC multiplexer
    sidecar.ts          — language server HTTP API for remy
  processes/
    process-registry.ts — unified process metadata + per-process logs
    process-manager.ts  — long-lived child process lifecycle
    file-watcher.ts     — chokidar file watcher
    tunnel-events.ts    — tunnel NDJSON event parser
  utils/
    paths.ts            — shared path utilities
```
