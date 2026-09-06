# MindStudio Sandbox — C&C Server

The command & control server that runs inside hosted MindStudio sandbox containers. Manages the dev environment, exposes a WebSocket API for the web editor, and reverse-proxies the live preview.

## Architecture

Single port (4387) serves everything:

```
Browser
  ├── wss://host/ws?token=...            → C&C WebSocket (editor control)
  ├── wss://host/lsp                     → TypeScript language server (LSP over JSON-RPC)
  ├── wss://host/__mindstudio_dev__/ws   → tunnel browser automation (direct proxy)
  ├── https://host/health                → health check (public)
  ├── https://host/*                     → reverse proxy → dev server (preview)
  └── wss://host/*                       → HMR relay → dev server (buffered during agent turns)
```

Internally, port 4388 runs the LSP HTTP sidecar for the remy agent.

Inside the container, the C&C server manages:
- **Dev server** (Vite / webpack / etc.) — frontend with HMR
- **Dev tunnel** (`mindstudio-local --headless`) — method execution, platform sync, browser automation
- **Remy agent** (`remy --headless`) — AI coding agent
- **File watcher** — broadcasts filesystem changes to connected clients
- **TypeScript language server** — shared between Monaco editor and remy
- **Snapshot manager** — periodic snapshots of the home directory to S3 for persistence across boxes

## Project Structure

```
src/
  index.ts                          — entry point, bootstrap orchestration
  config.ts                         — environment variable parsing
  types.ts                          — shared types (WS protocol, filesystem, app config)
  logger.ts                         — centralized logger with levels + elapsed time
  state.ts                          — persistent state (survives hibernate/resume)
  projectStatus.ts                  — onboarding state + project status tracking
  bootstrap.ts                      — install/clone/build commands
  projectStatus/HomeSnapshotManager.ts — home-directory snapshots (tar to S3 via youai-api)

  server/
    index.ts                        — HTTP/WS server, upgrade routing, broadcast
    context.ts                      — shared server context + init frame construction
    handlers/
      index.ts                      — action handler registry (routes WS actions)
      filesystem.ts                 — file operations (readFile, writeFile, etc.)
      shell.ts                      — shell command execution
      pty.ts                        — PTY terminal sessions
    states/
      EditorStateManager.ts         — code editor tabs + expanded dirs
      SpecEditorStateManager.ts     — spec editor tabs
      FileTreeManager.ts            — code file tree (lazy, expandedDirs-gated)
      SpecFileTreeManager.ts        — spec file tree (always fully expanded)
    server/
      BroadcastBatcher.ts           — batched WS event delivery (100ms flush)
      HmrRelay.ts                   — HMR WebSocket relay with buffering

  lsp/
    client.ts                       — language server JSON-RPC multiplexer
    sidecar.ts                      — language server HTTP API for remy

  processes/
    parseJsonEvent.ts               — shared NDJSON event parser
    ProcessRegistry.ts              — unified process metadata + per-process logs
    ProcessManager.ts               — long-lived child process lifecycle
    ResourceMonitor.ts              — memory/CPU metrics collection
    fileWatcher.ts                  — chokidar file watcher
    agent/
      index.ts                      — remy agent process management + IPC
      events.ts                     — typed agent event union
      history.ts                    — chat history transformation
    tunnel/
      index.ts                      — dev tunnel process management + IPC
      events.ts                     — typed tunnel event union
    devServer/index.ts              — dev server process management

  utils/
    paths.ts                        — shared path utilities
```

## IPC Protocol

Both the agent and tunnel use the same IPC pattern: newline-delimited JSON over stdin/stdout with `requestId`-based correlation.

**Sending commands:** Every stdin command includes a `requestId`. Responses carry the same `requestId`.

**System events vs command responses:** System events (lifecycle, connection status) have no `requestId`. Command responses always do. The handler distinguishes them with `if (msg.requestId)`.

**Agent specifics:** Streaming events (`text`, `thinking`, `tool_start`, etc.) carry the originating command's `requestId` and are broadcast to the frontend in real-time. Each command ends with a `completed` event. Messages sent while a turn is running are queued (see `queue_changed`/`agentQueueChanged`); when the turn ends, contiguous queued user messages and background results are delivered together as one merged turn — the first queued message's `requestId` is the turn's primary id, each absorbed message echoes its own `user_message` (`queued: true`, original `requestId`), and after the primary's `completed`, each other absorbed `requestId` gets a `completed` with the same outcome and `absorbed: true`. A queued user message promoted via `agentSetQueuedDelivery` is instead injected into the running turn at remy's next tool boundary (echoing `user_message` with `queued: true` and getting an `absorbed: true` terminal with the turn's outcome); if the turn ends first it drains normally. Passive background tools (e.g. specSync) never wake the agent — their results ride the next real turn as a hidden entry and never appear in the queue. `tool_result` is fire-and-forget (no `requestId`).

**Tunnel specifics:** Command responses are consumed by the resolver and returned as WS response data. System events are broadcast to the frontend.

Both use `sendAgentCommand` / `sendCommand` (in their respective `index.ts` files) which returns a promise that resolves when the `completed`/response event arrives.

## Connecting from the Frontend

### 1. Open a WebSocket

```typescript
const ws = new WebSocket(`wss://${cncDomain}/ws?token=${sandboxToken}`);
```

`cncDomain` and `sandboxToken` come from the platform API when a sandbox session is started.

### 2. Message types

Every incoming WebSocket message is JSON. There are three types:

```typescript
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.requestId) {
    handleResponse(msg);        // reply to a request you sent
  } else if (msg.batch) {
    handleBatchedEvent(msg);    // batched: processStateChanged, fileChanged, ptyOutput
  } else if (msg.event) {
    handleEvent(msg);           // single pushed event
  }
};
```

### 3. Send requests

Every request has a `requestId` (client-generated), an `action`, and `params`. The server responds with the same `requestId`.

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

### 4. Handle the init frame

The first message on connect is an `init` event with everything needed to bootstrap the UI — no round-trips required:

```json
{
  "event": "init",
  "status": "ready",
  "previewAvailable": true,
  "app": { "appId": "...", "name": "...", "methods": [...], "tables": [...], "interfaces": [...], "roles": [...], "scenarios": [...] },
  "tunnelSession": { "sessionId": "...", "releaseId": "...", "branch": "main", "proxyPort": 3835, "proxyUrl": "...", "webInterfaceUrl": "..." },
  "activeImpersonation": ["ap"],
  "fileTree": [...],
  "specFileTree": [...],
  "chatHistory": [...],
  "processes": [...],
  "editorState": { "tabs": [...], "activeTab": "...", "expandedDirs": [...] },
  "specEditorState": { "tabs": [...], "activeTab": "..." },
  "agentActivity": { "busy": false, "fileOps": [] },
  "projectStatus": { "specDirty": false, "codeDirty": false, "onboardingState": "onboardingFinished" },
  "ptySessionIds": []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"bootstrapping" \| "ready" \| "error"` | Server lifecycle status |
| `previewAvailable` | `boolean` | Whether the preview proxy is ready |
| `app` | `AppConfig` | Parsed `mindstudio.json` (includes roles, scenarios, methods, tables, interfaces) |
| `tunnelSession` | `TunnelSessionState \| null` | Active tunnel session info, or null if not connected |
| `activeImpersonation` | `string[] \| null` | Currently impersonated role IDs, or null |
| `fileTree` | `TreeEntry[]` | Code file tree (based on expanded dirs) |
| `specFileTree` | `TreeEntry[]` | Spec file tree (`src/` — always fully expanded) |
| `chatHistory` | `Message[]` | Agent conversation history from remy. Assistant messages carry `model?` and `modelOverride?` — see [Model selection](#model-selection) |
| `processes` | `ProcessInfo[]` | All tracked processes |
| `editorState` | `EditorState` | Code editor tabs + active tab + expanded dirs |
| `specEditorState` | `SpecEditorState` | Spec editor tabs + active tab |
| `agentActivity` | `AgentActivity` | Current agent file operations |
| `projectStatus` | `ProjectStatus` | `{ specDirty, codeDirty, onboardingState }` — sync flags + onboarding phase |
| `ptySessionIds` | `string[]` | Active PTY terminal sessions |

## Actions (Client → Server)

### Filesystem

| Action | Params | Description |
|--------|--------|-------------|
| `readFile` | `{ path }` | Read file contents. Returns `{ content, encoding }` |
| `writeFile` | `{ path, content }` | Write/create a file. Parent dirs created automatically |
| `deleteFile` | `{ path }` | Delete a file or directory (recursive) |
| `renameFile` | `{ oldPath, newPath }` | Move or rename a file |
| `shell` | `{ command, cwd?, timeout? }` | Run a shell command. Returns `{ exitCode, stdout, stderr }` |

### Code Editor

| Action | Params | Description |
|--------|--------|-------------|
| `openFile` | `{ path, preview? }` | Open a tab. `preview: true` = replaceable single-click tab |
| `closeFile` | `{ path }` | Close a tab |
| `setActiveTab` | `{ path }` | Switch active tab |
| `reorderTabs` | `{ paths }` | Reorder tabs (drag-and-drop) |
| `expandDir` | `{ path }` | Expand a directory in the file tree |
| `collapseDir` | `{ path }` | Collapse a directory |
| `toggleDir` | `{ path }` | Toggle a directory's expanded state |

### Spec Editor

| Action | Params | Description |
|--------|--------|-------------|
| `specOpenFile` | `{ path, preview? }` | Open a tab in the spec editor |
| `specCloseFile` | `{ path }` | Close a spec tab |
| `specSetActiveTab` | `{ path }` | Switch active spec tab |

### Agent

All agent actions await the agent's `completed` event and return it as the WS response. Streaming events (`agentText`, `agentThinking`, `agentToolStart`, etc.) are broadcast separately while the command is in flight.

| Action | Params | Description |
|--------|--------|-------------|
| `agentMessage` | `{ text, attachments?, viewContext?, buildModel? }` | Send a message to the agent. If the agent is idle, returns on `completed`; if a turn is running, returns immediately with `{ queued: true, requestId }` and the message's own `completed` arrives when it eventually runs (possibly merged into one turn with other queued messages). `buildModel` picks the model that executes an approved plan — see [Model selection](#model-selection) |
| `agentCancel` | `{}` | Cancel current agent turn. Returns when cancel is confirmed; the reply carries `cancelledMessages` (queued chain/background items flushed by the cancel — queued user messages are preserved and run next) |
| `agentCancelQueued` | `{ id? }` | Remove pending queued user messages without touching the in-flight turn. Omit `id` for all, or pass a queued message's `requestId`. Replies with `cancelledQueued`; the queue snapshot updates via `agentQueueChanged` |
| `agentSetQueuedDelivery` | `{ id, delivery }` | Promote a queued user message to `"asap"` (remy injects it into the running turn at its next tool boundary) or demote back to `"afterTurn"`. Only plain user messages qualify — remy replies `success:false` for automated/chain/background items or an already-consumed id. Snapshot updates via `agentQueueChanged` |

#### Automated Actions

Trigger automated actions by sending `agentMessage` with the `@@automated::` sentinel format in `text`:

```
@@automated::actionName@@
@@automated::actionName@@{"param": "value"}
```

Params JSON goes right after the closing `@@`. Each key is interpolated into `{{key}}` placeholders in the action prompt.

| Action | Params | Description |
|--------|--------|-------------|
| `sync` | — | Spec ↔ code sync |
| `publish` | — | Publish flow |
| `buildFromInitialSpec` | — | Initial build from spec |
| `buildFromRoadmap` | `{ path }` | Build a roadmap item |
| `reviseFromAnnotatedImage` | — | Revise from annotated image |

Messages with `@@automated::` prefix in history are automated — use the prefix to identify them for UI rendering. `@@automated::background_results@@` messages continue to work as before.
| `agentClear` | `{}` | Clear conversation, start fresh session |
| `externalToolResult` | `{ id, result }` | Send a result back for any external tool (promptUser, presentSyncPlan, etc.). Fire-and-forget |
| `setProjectOnboardingState` | `{ state }` | Advance onboarding state |

#### Model selection

Planning always runs on the strong default model. When the user approves a **normal**
plan, they may optionally choose a cheaper/faster model to *execute* that build.

**Sending the choice.** Add `buildModel` to the `agentMessage` params alongside the
approve sentinel:

```json
{ "action": "agentMessage",
  "requestId": "…",
  "params": { "text": "@@automated::approvePlan@@", "buildModel": "deepseek-v4-flash-0731" } }
```

Omit `buildModel` entirely to use the default — that payload is identical to what was
sent before this field existed. The sandbox forwards the value verbatim; remy scopes and
validates it:

- honored only on the `approvePlan` message — ignored on chat approvals ("looks good, go
  ahead") and on the initial onboarding approval, which always uses the strong model
- an unknown or invalid id is ignored and the build falls back to the default
- it applies to the **parent agent only**; specialist subagents (design, QA, architecture,
  copy, spec-sync) keep their own models, so a build "on DeepSeek" did not run entirely
  on DeepSeek
- it rides along with the approved plan for the life of that build across multiple turns
  — do **not** resend it on continuation messages. A new plan starts fresh on the default.

**Populating the picker.** No extra round-trip needed — `agentSessionRestored`,
`agentModelsChanged`, and the history response all carry:

| Field | Use |
|-------|-----|
| `allowedModelsByType.text` | The valid build models (the dropdown's options) |
| `modelSurfaces.parent.default` | The current effective default — the "build with the usual model" choice; selecting it means send no `buildModel` |
| `models` | Sparse map of per-agent picks active on the session |

**Reading attribution back.** Assistant messages in `chatHistory` carry `model` (the model
that produced them), and `modelOverride: { from }` when a build override made that turn
diverge from the user's default. Nested subagent messages inside a tool block's
`subAgentMessages` carry their own `model` and never a `modelOverride`.

Apply any "this ran on a different model" treatment **if and only if `modelOverride` is
present** — do not derive it by comparing `model` to the default. A user who simply
changes their own default mid-session produces messages with a different `model` and no
`modelOverride`, and that deliberate choice is intentionally left unmarked.

`agentTurnStarted` carries the same two fields for the in-flight turn, so live rendering
and post-reload rendering agree. Older messages predate this and have neither field.

### Tunnel

All tunnel actions await the tunnel's response and return it as the WS response.

| Action | Params | Description |
|--------|--------|-------------|
| `tunnelRunScenario` | `{ scenarioId }` | Run a scenario (truncate + seed + impersonate). Returns result |
| `tunnelRunMethod` | `{ method, input? }` | Run a method directly. Returns output |
| `tunnelBrowser` | `{ steps }` | Execute browser automation steps. Returns step results |
| `tunnelScreenshot` | `{}` | Capture a full-page screenshot. Returns `{ url, width, height, duration }` |
| `tunnelBrowserStatus` | `{}` | Check if a browser is connected. Returns `{ connected }` |
| `tunnelResetBrowser` | `{}` | Reload all connected browser tabs |
| `tunnelImpersonate` | `{ roles }` | Set role overrides for method execution |
| `tunnelClearImpersonation` | `{}` | Clear role overrides |

Schema sync is automatic (tunnel watches table files). Roles and scenarios come from `app` in the init frame.

### Processes

| Action | Params | Description |
|--------|--------|-------------|
| `getProcesses` | `{}` | Get all tracked processes |
| `restartProcess` | `{ name }` | Restart a process |
| `getResources` | `{}` | Get memory/CPU metrics snapshot |

### PTY

| Action | Params | Description |
|--------|--------|-------------|
| `ptyCreate` | `{ cols?, rows?, cwd? }` | Create a new terminal session |
| `ptyWrite` | `{ sessionId, data }` | Write to a terminal |
| `ptyResize` | `{ sessionId, cols, rows }` | Resize a terminal |
| `ptyClose` | `{ sessionId }` | Close a terminal session |
| `ptyGetScrollback` | `{ sessionId }` | Get terminal scrollback buffer |

## Events (Server → Client)

### File System

| Event | Payload | Description |
|-------|---------|-------------|
| `fileChanged` | `{ batch }` | File created/modified/deleted. Batched every 100ms. Each item: `{ path, changeType }` |
| `fileTreeChanged` | `{ fileTree }` | Code file tree updated (structural changes) |
| `specFileTreeChanged` | `{ specFileTree }` | Spec file tree updated (`src/` structural changes) |
| `manifestChanged` | `{ app }` | `mindstudio.json` changed — updated AppConfig |

### Editor State

| Event | Payload | Description |
|-------|---------|-------------|
| `editorStateChanged` | `{ editorState }` | Code editor tabs/active changed. **Replace local state entirely.** |
| `specEditorStateChanged` | `{ specEditorState }` | Spec editor tabs/active changed. **Replace local state entirely.** |
| `projectStatusChanged` | `{ projectStatus }` | Onboarding state or sync dirty flags changed |

### Agent

Streaming events are broadcast in real-time while a message command is in flight. They carry `requestId` (from the originating `agentMessage` command) and optionally `parentToolId` (for sub-agent events).

| Event | Payload | Description |
|-------|---------|-------------|
| `agentReady` | | Agent initialized and ready |
| `agentTurnStarted` | `{ requestId?, model?, modelOverride? }` | A turn began. `model` is the model executing it; `modelOverride` (`{ from }`) is present only when a "Build with X" override put this turn on a non-default model. Gives live attribution for the in-flight turn — the same values persist on the message in `chatHistory` after reload |
| `agentThinking` | `{ text, requestId?, parentToolId? }` | Internal reasoning (streaming chunks) |
| `agentText` | `{ text, requestId?, parentToolId? }` | Visible response text (streaming chunks) |
| `agentToolStart` | `{ id, name, input, partial?, requestId?, parentToolId? }` | Tool execution started. For streaming tools (promptUser, presentSyncPlan, etc.), multiple events with `partial: true` arrive before the final one |
| `agentToolInputDelta` | `{ id, name, result, requestId?, parentToolId? }` | Streaming tool input content (progressive updates) |
| `agentToolDone` | `{ id, name, result?, isError?, requestId?, parentToolId? }` | Tool execution completed |
| `agentCompleted` | `{ requestId, success, error?, absorbed? }` | Command finished. Also returned as the WS response for the originating action. `absorbed: true` marks the synthetic terminal of a requestId that was merged into another turn — it resolves that command but carries no turn lifecycle (the primary requestId's completed, which arrives first, drives busy/turn-done) |
| `agentUserMessage` | `{ text, requestId?, attachments?, queued?, hidden? }` | A user message entering a turn, echoed by remy. Queue-delivered messages (including ASAP-promoted ones injected mid-turn) carry `queued: true` and their own original `requestId`; a merged turn emits one per absorbed message. `hidden: true` marks internal entries (passive background results) — do not render |
| `agentQueueChanged` | `{ queuedMessages }` | Remy's pending-message queue changed. Full authoritative snapshot (empty array when drained); items carry `delivery: "asap"` when promoted. The initial snapshot rides on the init frame and `agentGetHistory` |
| `agentStatus` | `{ message, requestId? }` | Contextual status label (e.g., "Writing files...") |
| `agentError` | `{ message?, error?, requestId? }` | Agent error |
| `agentStopping` | | Agent shutting down |
| `agentStopped` | | Agent process exited |
| `agentSessionRestored` | `{ messageCount?, models?, modelSurfaces?, allowedModelsByType? }` | Previous session restored on startup. Carries the model registry — see [Model selection](#model-selection) |
| `agentModelsChanged` | `{ models?, modelSurfaces?, allowedModelsByType? }` | Model picks or the registry changed. Same payload shape as `agentSessionRestored` |
| `agentActivityChanged` | `{ busy, fileOps }` | Agent activity tracking. `busy` is derived: a turn is running OR work is queued OR a compaction is in flight (remy queues messages behind a compaction exactly like a running turn). `fileOps`: `[{ toolCallId, path, action }]` where `action` is `reading`, `writing`, or `editing` |
| `agentCompactionStarted` | `{ blocking, requestId? }` | A conversation compaction began |
| `agentCompactionComplete` | `{ error?, requestId? }` | Compaction finished. Every compaction also renders as a normal `compactConversation` tool call (user/gate compactions get a remy-synthesized tool block driven by standard `agentToolStart`/`agentToolBackgroundComplete` events; the summary is the block's `backgroundResult`) |

### Processes

| Event | Payload | Description |
|-------|---------|-------------|
| `processStateChanged` | `{ batch }` | Process state transitions. Batched every 100ms |
| `resourceSnapshot` | `{ timestamp, container, processes }` | Memory/CPU metrics (every 5s) |

### Tunnel

System events from the tunnel are broadcast as `tunnelEvent`. Command responses are not broadcast — they're returned as WS response data for the originating action.

| Event | Payload | Description |
|-------|---------|-------------|
| `tunnelEvent` | `{ event, ... }` | Tunnel system events forwarded as-is |

Key tunnel system events:

| Tunnel Event | Payload | Description |
|-------------|---------|-------------|
| `session-starting` | `{ appId, name }` | Session initializing |
| `session-started` | `{ sessionId, releaseId, branch, proxyPort, proxyUrl, webInterfaceUrl, roles, scenarios }` | Session active, proxy running |
| `session-stopping` | | Graceful shutdown initiated |
| `session-stopped` | | Session fully stopped |
| `session-expired` | | Platform expired the session |
| `platform-method-started` | `{ id, method }` | Platform-triggered method execution began |
| `platform-method-completed` | `{ id, success, duration, error? }` | Platform-triggered method execution finished |
| `scenario-started` | `{ id, name }` | Scenario being applied |
| `scenario-completed` | `{ id, success, duration, roles, error? }` | Scenario finished |
| `schema-sync-started` | | Table file change detected, syncing |
| `schema-sync-completed` | `{ created, altered, errors }` | Schema sync finished |
| `impersonation-changed` | `{ roles }` | Role override set or cleared (`roles: null` when cleared) |
| `connection-lost` | `{ message }` | Lost connection to platform, retrying |
| `connection-restored` | | Reconnected after loss |
| `config-changed` | | `mindstudio.json` modified, session restarting |
| `config-error` | `{ message }` | Non-fatal config error |
| `error` | `{ message }` | Fatal error |

### Bootstrap

| Event | Payload | Description |
|-------|---------|-------------|
| `bootstrapProgress` | `{ step, message }` | Bootstrap status updates. Steps: `installTunnel`, `installAgent`, `installLsp`, `cloneApp`, `installDeps`, `devServer`, `tunnel`, `agent`, `ready`, `error` |

### PTY

| Event | Payload | Description |
|-------|---------|-------------|
| `ptyOutput` | `{ batch }` | Terminal output. Batched every 100ms. Each item: `{ sessionId, data }` |

## Editor State

The server owns all editor state. The frontend renders it and sends actions to mutate it.

### Code editor state

```typescript
{
  tabs: Array<{ path: string; isPreview: boolean }>;
  activeTab: string | null;
  expandedDirs: string[];
}
```

- **Preview tabs** (`isPreview: true`) — single-click in file tree. Replaced by the next preview-open.
- **Pinned tabs** (`isPreview: false`) — double-click or explicit open. Stay open until closed.
- **Expanded dirs** — paths of expanded directories in the file tree.

### Spec editor state

```typescript
{
  tabs: Array<{ path: string; isPreview: boolean }>;
  activeTab: string | null;
}
```

Same tab semantics, no expanded dirs (spec sidebar is flat sections).

### State flow

1. On init, replace local state entirely with the init frame values
2. Send actions to mutate (`openFile`, `closeFile`, etc.)
3. Listen for `editorStateChanged` / `specEditorStateChanged` — always replace local state with the broadcast
4. Both user actions and the agent can trigger state changes

## TypeScript Language Server

### WebSocket connection

```
wss://{cncDomain}/lsp
```

No auth token required. Carries raw JSON-RPC (Language Server Protocol) messages.

### Monaco setup

```typescript
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction } from 'vscode-languageclient';

// 1. Disable Monaco's built-in TypeScript worker
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});

// 2. Connect
const ws = new WebSocket(`wss://${cncDomain}/lsp`);
ws.onopen = () => {
  const socket = toSocket(ws);
  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);

  // 3. Create language client
  const client = new MonacoLanguageClient({
    name: 'TypeScript Language Client',
    clientOptions: {
      documentSelector: [
        { scheme: 'file', language: 'typescript' },
        { scheme: 'file', language: 'typescriptreact' },
        { scheme: 'file', language: 'javascript' },
        { scheme: 'file', language: 'javascriptreact' },
      ],
      errorHandler: {
        error: () => ({ action: ErrorAction.Continue }),
        closed: () => ({ action: CloseAction.Restart }),
      },
    },
    connectionProvider: {
      get: () => Promise.resolve({ reader, writer }),
    },
  });

  client.start();
};
```

### File URIs

The language server uses `file://` URIs rooted at the workspace:

```typescript
const WORKSPACE_DIR = '/home/remy/workspace';
const uri = monaco.Uri.parse(`file://${WORKSPACE_DIR}/${relativePath}`);
const model = monaco.editor.createModel(content, 'typescript', uri);
```

### Available features

Autocomplete, diagnostics (pushed automatically), hover, go-to-definition, find references, rename, code actions, signature help, document symbols.

### Required packages

```bash
npm install monaco-languageclient vscode-ws-jsonrpc
```

## Live Preview

```html
<iframe src={`https://${cncDomain}/`} />
```

Reverse-proxied to the dev server. Available once `tunnelEvent` with `session-started` arrives. Before that, returns 503. Supports HMR — the HMR WebSocket is relayed with buffering during agent file edits to prevent broken intermediate states.

The tunnel's browser automation WebSocket (`/__mindstudio_dev__/ws`) is proxied directly without buffering.

## Scenarios & Roles

**Roles** are string identifiers (e.g., `"admin"`, `"ap"`) checked at runtime via `auth.requireRole()`. During development, use `tunnelImpersonate` to set role overrides.

**Scenarios** are seed scripts that set up the dev database. Running a scenario (`tunnelRunScenario`) truncates all tables, executes the seed function, and applies the scenario's roles. Scenarios are declared in `mindstudio.json` and listed in the `session-started` tunnel event.

## Snapshots

The snapshot manager tars the whole home directory (`/home/remy`: workspace, `node_modules`, `.git`, global npm installs, dotfiles, caches) and uploads it to S3 through youai-api's `workspace-snapshot` routes — on SIGTERM and every five minutes while anything changed. On boot, it downloads and extracts the app's current snapshot; an app without one is cloned from git. Only the app's newest sandbox session may commit a snapshot, so a replaced box cannot overwrite its successor's work.

## Health Check

```
GET /health → { "status": "ready|bootstrapping|error", "proxyTarget": 3835|null }
```

## Error Handling

Failed requests return:
```json
{ "requestId": "...", "success": false, "error": "Path escapes workspace" }
```

All file paths are relative to the workspace root. Paths that escape the workspace are rejected.

## Environment Variables

| Var | Purpose | Default |
|-----|---------|---------|
| `GIT_REPO_URL` | App git repo to clone | required |
| `MINDSTUDIO_API_KEY` | Developer's API key (for tunnel + agent) | required |
| `USER_ID` | Developer's user ID (for tunnel) | required |
| `API_BASE_URL` | Platform API URL | `https://api.mindstudio.ai` |
| `PORT` | Server port | `4387` |
| `SANDBOX_TOKEN` | WebSocket auth token | none (no auth) |
| `LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error` | `info` |

## Development

```bash
npm install
GIT_REPO_URL=test MINDSTUDIO_API_KEY=test USER_ID=test PORT=4387 npx tsx src/index.ts
npx tsc --noEmit   # type-check
npm run build       # compile
```

The `example/` directory contains a sample MindStudio app for local testing.
