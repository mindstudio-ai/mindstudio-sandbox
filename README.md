# MindStudio Sandbox — C&C Server

The command & control server that runs inside hosted MindStudio sandbox containers. Manages the dev environment, exposes a WebSocket API for the web editor, and reverse-proxies the live preview.

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

## Project Structure

```
src/
  index.ts                          — entry point, bootstrap orchestration
  config.ts                         — environment variable parsing
  types.ts                          — shared types (WS protocol, filesystem, app config)
  logger.ts                         — centralized logger with levels + elapsed time
  state.ts                          — persistent state (survives hibernate/resume)
  syncStatus.ts                     — spec/code sync status tracking + git sync ref
  bootstrap.ts                      — install/clone/build commands
  snapshot.ts                       — git-based session snapshots (_draft branch)

  server/
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
      _helpers/
        getProjectHasCode.ts        — derives projectHasCode from manifest
    server/
      BroadcastBatcher.ts           — batched WS event delivery (100ms flush)
      HmrRelay.ts                   — HMR WebSocket relay with buffering

  lsp/
    client.ts                       — language server JSON-RPC multiplexer
    sidecar.ts                      — language server HTTP API for remy

  processes/
    ProcessRegistry.ts              — unified process metadata + per-process logs
    ProcessManager.ts               — long-lived child process lifecycle
    ResourceMonitor.ts              — memory/CPU metrics collection
    fileWatcher.ts                  — chokidar file watcher
    agent/
      index.ts                      — remy agent process management
      events.ts                     — typed agent event union + parser
      history.ts                    — chat history transformation
    tunnel/
      index.ts                      — dev tunnel process management
      events.ts                     — typed tunnel event union + parser
    devServer/index.ts              — dev server process management

  utils/
    paths.ts                        — shared path utilities
```

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
    handleBatchedEvent(msg);    // batched: processOutput, processStateChanged
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
  "outputLog": [...],
  "editorState": { "tabs": [...], "activeTab": "...", "expandedDirs": [...] },
  "specEditorState": { "tabs": [...], "activeTab": "..." },
  "projectHasCode": false,
  "viewMode": "intake",
  "syncStatus": { "specDirty": false, "codeDirty": false },
  "agentActivity": { "busy": false, "fileOps": [] },
  "pendingExternalTools": [],
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
| `chatHistory` | `Message[]` | Agent conversation history from remy |
| `processes` | `ProcessInfo[]` | All tracked processes |
| `outputLog` | `ProcessLogEntry[]` | Merged log (last 5000 lines) |
| `editorState` | `EditorState` | Code editor tabs + active tab + expanded dirs |
| `specEditorState` | `SpecEditorState` | Spec editor tabs + active tab |
| `projectHasCode` | `boolean` | Whether manifest declares methods or interfaces |
| `viewMode` | `ViewMode` | Current editor tab: `intake`, `preview`, `spec`, `code`, `databases`, `scenarios`, `logs` |
| `syncStatus` | `SyncStatus` | `{ specDirty, codeDirty }` — whether user edits need syncing |
| `agentActivity` | `AgentActivity` | Current agent file operations |
| `pendingExternalTools` | `PendingExternalTool[]` | Unanswered external tool calls (e.g., promptUser) |
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

| Action | Params | Description |
|--------|--------|-------------|
| `agentMessage` | `{ text, attachments? }` | Send a message to the agent. Streams response as events |
| `agentSync` | `{}` | Trigger spec ↔ code sync. Remy diffs and updates the stale side |
| `agentPublish` | `{}` | Trigger publish flow. Remy presents a plan for approval |
| `agentCancel` | `{}` | Cancel current agent turn |
| `agentClear` | `{}` | Clear conversation, start fresh session |
| `externalToolResult` | `{ id, result }` | Send a result back for any external tool (promptUser, presentSyncPlan, presentPublishPlan). `result` is a string |

### Processes

| Action | Params | Description |
|--------|--------|-------------|
| `getProcesses` | `{}` | Get all tracked processes |
| `restartProcess` | `{ name }` | Restart a process |
| `getProcessLog` | `{ name }` | Get per-process log buffer (up to 1000 lines) |
| `getResources` | `{}` | Get memory/CPU metrics snapshot |

### Tunnel

| Action | Params | Description |
|--------|--------|-------------|
| `tunnelRunScenario` | `{ scenarioId }` | Run a scenario (truncate + seed + impersonate) |
| `tunnelImpersonate` | `{ roles }` | Set role overrides for method execution |
| `tunnelClearImpersonation` | `{}` | Clear role overrides |

Schema sync is automatic (tunnel watches table files). Roles and scenarios come from `app` in the init frame.

### View Mode

| Action | Params | Description |
|--------|--------|-------------|
| `setViewMode` | `{ mode }` | Switch editor tab. Values: `intake`, `preview`, `spec`, `code`, `databases`, `scenarios`, `logs` |

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
| `fileChanged` | `{ path, changeType }` | File created/modified/deleted (by agent, git, etc.) |
| `fileTreeChanged` | `{ fileTree }` | Code file tree updated (structural changes) |
| `specFileTreeChanged` | `{ specFileTree }` | Spec file tree updated (`src/` structural changes) |
| `manifestChanged` | `{ app }` | `mindstudio.json` changed — updated AppConfig |

### Editor State

| Event | Payload | Description |
|-------|---------|-------------|
| `editorStateChanged` | `{ editorState }` | Code editor tabs/active changed. **Replace local state entirely.** |
| `specEditorStateChanged` | `{ specEditorState }` | Spec editor tabs/active changed. **Replace local state entirely.** |
| `projectHasCodeChanged` | `{ projectHasCode }` | `projectHasCode` flag changed (compiler added methods/interfaces) |

### Agent

| Event | Payload | Description |
|-------|---------|-------------|
| `agentReady` | | Agent initialized and ready |
| `agentTurnStarted` | | Agent began processing a message |
| `agentThinking` | `{ text }` | Internal reasoning (streaming chunks) |
| `agentText` | `{ text }` | Visible response text (streaming chunks) |
| `agentToolStart` | `{ id, name, input, partial? }` | Tool execution started. For streaming tools (promptUser, presentSyncPlan, presentPublishPlan), multiple events with `partial: true` arrive before the final one |
| `agentToolInputDelta` | `{ id, name, result }` | Streaming tool input content (progressive updates) |
| `agentToolDone` | `{ id, name, result?, isError? }` | Tool execution completed |
| `agentTurnDone` | | Agent finished responding |
| `agentTurnCancelled` | | Turn cancelled (via `agentCancel`) |
| `agentError` | `{ message }` | Agent error |
| `agentStopping` | | Agent shutting down |
| `agentStopped` | | Agent process exited |
| `agentSessionRestored` | | Previous session restored on startup |
| `agentSessionCleared` | | Session cleared (via `agentClear`) |
| `agentActivityChanged` | `{ busy, fileOps }` | Agent file operation tracking. `fileOps`: `[{ toolCallId, path, action }]` where `action` is `reading`, `writing`, or `editing` |

### Processes (batched)

| Event | Payload | Description |
|-------|---------|-------------|
| `processOutput` | `{ batch }` | Log lines from tracked processes. Batched every 100ms |
| `processStateChanged` | `{ batch }` | Process state transitions. Batched every 100ms |
| `resourceSnapshot` | `{ timestamp, container, processes }` | Memory/CPU metrics (every 5s) |

### Tunnel

| Event | Payload | Description |
|-------|---------|-------------|
| `tunnelEvent` | `{ event, ... }` | All tunnel events forwarded as-is |

Key tunnel events:

| Tunnel Event | Payload | Description |
|-------------|---------|-------------|
| `session-starting` | `{ appId, name }` | Session initializing |
| `session-started` | `{ sessionId, releaseId, branch, proxyPort, proxyUrl, webInterfaceUrl, roles, scenarios }` | Session active, proxy running |
| `session-stopping` | | Graceful shutdown initiated |
| `session-stopped` | | Session fully stopped |
| `session-expired` | | Platform expired the session |
| `method-started` | `{ id, method }` | Method execution began |
| `method-completed` | `{ id, success, duration, error? }` | Method execution finished |
| `scenario-started` | `{ id, name }` | Scenario being applied |
| `scenario-completed` | `{ id, success, duration, roles, error? }` | Scenario finished |
| `schema-sync-started` | | Table file change detected, syncing |
| `schema-sync-completed` | `{ created, altered, errors }` | Schema sync finished |
| `impersonation-changed` | `{ roles }` | Role override set or cleared (`roles: null` when cleared) |
| `connection-lost` | `{ message }` | Lost connection to platform, retrying |
| `connection-restored` | | Reconnected after loss |
| `config-changed` | | `mindstudio.json` modified, session restarting |
| `config-error` | `{ message }` | Non-fatal config error |
| `command-error` | `{ message }` | Stdin command failed |
| `error` | `{ message }` | Fatal error |

### Sync Status

| Event | Payload | Description |
|-------|---------|-------------|
| `syncStatusChanged` | `{ specDirty, codeDirty }` | Spec/code sync flags changed |

### View Mode

| Event | Payload | Description |
|-------|---------|-------------|
| `viewModeChanged` | `{ viewMode }` | Editor tab switched (by agent or user) |

### Bootstrap

| Event | Payload | Description |
|-------|---------|-------------|
| `bootstrapProgress` | `{ step, message }` | Bootstrap status updates. Steps: `installTunnel`, `installAgent`, `installLsp`, `cloneApp`, `installDeps`, `devServer`, `tunnel`, `agent`, `ready`, `error` |

### PTY

| Event | Payload | Description |
|-------|---------|-------------|
| `ptyOutput` | `{ sessionId, data }` | Terminal output |
| `ptyClosed` | `{ sessionId, exitCode }` | Terminal session closed |

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

### `projectHasCode`

Derived from the manifest — `true` when methods or interfaces are declared. Sent in the init frame and via `projectHasCodeChanged` events. The frontend uses this to control whether the Code view toggle is enabled.

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
const WORKSPACE_DIR = '/home/vercel-sandbox/workspace';
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

Reverse-proxied to the dev server. Available once `tunnelEvent` with `session-started` arrives. Before that, returns 503. Supports HMR.

## Scenarios & Roles

**Roles** are string identifiers (e.g., `"admin"`, `"ap"`) checked at runtime via `auth.requireRole()`. During development, use `tunnelImpersonate` to set role overrides.

**Scenarios** are seed scripts that set up the dev database. Running a scenario (`tunnelRunScenario`) truncates all tables, executes the seed function, and applies the scenario's roles. Scenarios are declared in `mindstudio.json` and listed in the `session-started` tunnel event.

## Health Check

```
GET /health → { "status": "ready", "proxyTarget": 3835 }
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
