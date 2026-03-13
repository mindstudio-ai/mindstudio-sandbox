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
- **File watcher** — broadcasts filesystem changes to connected clients

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
      "children": [
        { "name": "methods", "path": "dist/methods", "type": "directory", "children": [...] },
        { "name": "interfaces", "path": "dist/interfaces", "type": "directory", "children": [...] }
      ]
    },
    { "name": "mindstudio.json", "path": "mindstudio.json", "type": "file", "size": 1073, "modified": "..." }
  ],
  "chatHistory": [
    { "role": "user", "content": "add a delete method for haikus" },
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "I'll read the table schema first." },
        { "type": "tool", "id": "tc_1", "name": "readFile", "input": { "path": "src/tables/haikus.ts" }, "result": "...", "isError": false },
        { "type": "tool", "id": "tc_2", "name": "writeFile", "input": { "path": "src/deleteHaiku.ts" }, "result": "Created...", "isError": false },
        { "type": "text", "text": "Done. Created deleteHaiku method with soft-delete." }
      ]
    }
  ]
}
```

| Field | Contents |
|-------|----------|
| `status` | Server status: `"bootstrapping"`, `"ready"`, or `"error"` |
| `previewAvailable` | Whether the preview proxy is ready |
| `app` | Parsed `mindstudio.json` — app name, methods, tables, interfaces |
| `fileTree` | Recursive file tree (3 levels deep), directories first, alphabetical. Excludes `node_modules`, `.git`, `.vite`. |
| `chatHistory` | Full agent conversation history. Empty array if no messages yet. Persists across reconnects. |

Each tree entry has `name`, `path` (relative), `type`, `size`, `modified`,
and `children` (for directories within the depth limit). Use `listDir`
to lazily load deeper levels.

User messages have `content` as a string. Assistant messages have
`content` as an ordered array of blocks — `{ type: "text", text }` and
`{ type: "tool", id, name, input, result?, isError? }` — preserving
the exact sequence of text → tool calls → more text. Render them in
order. If the agent is mid-response when you connect, the last
assistant entry may have partial text and in-progress tool calls
(missing `result`).

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

Response:
```json
{ "requestId": "...", "success": true, "data": {} }
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

Response:
```json
{
  "requestId": "...",
  "success": true,
  "data": {
    "results": [
      { "file": "src/App.tsx", "line": 3, "column": 10, "text": "const [count, setCount] = useState(0);" }
    ]
  }
}
```

`glob` and `caseSensitive` are optional. `maxResults` defaults to 100.
Results always exclude `node_modules/`, `.git/`, and `.vite/`.

### `shell`

Run an arbitrary shell command.

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
lines are also streamed as `processOutput` events.

Use `shell` for git operations, npm commands, running scripts, or
anything else — the sandbox is an isolated container.

### `agentMessage`

Send a message to the AI coding agent. Response is an immediate ack —
the agent's output streams as pushed events (see below).

```json
{ "requestId": "...", "action": "agentMessage", "params": { "text": "add a delete method for haikus" } }
```

Response:
```json
{ "requestId": "...", "success": true, "data": {} }
```

Then listen for `agentThinking`, `agentText`, `agentToolStart`,
`agentToolDone`, and `agentTurnDone` events.

### `agentCancel`

Cancel the current agent turn. Kills and restarts the agent process.

```json
{ "requestId": "...", "action": "agentCancel", "params": {} }
```

## Pushed Events

Events are broadcast to all connected clients. They have an `event`
field and no `requestId`.

### `fileChanged`

A file was created, modified, or deleted outside of the WebSocket
(e.g., by git, npm install, or the dev server). Not fired for changes
made via `writeFile` / `deleteFile` / `renameFile` actions.

```json
{ "event": "fileChanged", "path": "src/App.tsx", "changeType": "modified" }
```

`changeType` is `"created"`, `"modified"`, or `"deleted"`.

### `processOutput`

A line of stdout or stderr from a managed process.

```json
{ "event": "processOutput", "process": "devServer", "stream": "stdout", "line": "VITE v7.3.1 ready in 320ms" }
```

`process` is `"devServer"`, `"tunnel"`, `"agent"`, or `"shell"`.

### `tunnelEvent`

A parsed JSON event from the dev tunnel's headless output.

```json
{ "event": "tunnelEvent", "event": "session-started", "sessionId": "...", "proxyPort": 3835 }
```

Key tunnel events:
- `starting` — tunnel initializing
- `session-started` — platform session active (has `sessionId`, `proxyPort`)
- `schema-synced` — table schemas synced (`created`, `altered`, `errors`)
- `method-start` — method execution started (`id`, `method`)
- `method-complete` — method execution finished (`id`, `success`, `duration`)
- `session-expired` — platform expired the session
- `error` — fatal tunnel error

### `bootstrapProgress`

Status updates during sandbox bootstrap.

```json
{ "event": "bootstrapProgress", "step": "installDeps", "message": "Installing dependencies..." }
```

Steps in order: `installTunnel`, `installAgent`, `cloneApp`,
`installDeps`, `devServer`, `tunnel`, `agent`, `ready`, or `error`.

### Agent Events

These stream while the agent is processing a message (after
`agentMessage` action). They map 1:1 from remy's headless protocol.

#### `agentReady`
Agent process initialized and ready for messages.
```json
{ "event": "agentReady" }
```

#### `agentThinking`
Agent's internal reasoning (streaming chunks).
```json
{ "event": "agentThinking", "text": "Let me look at the table schema..." }
```

#### `agentText`
Agent's visible response text (streaming chunks).
```json
{ "event": "agentText", "text": "I've added the delete method. " }
```

#### `agentToolStart`
Agent started executing a tool.
```json
{ "event": "agentToolStart", "id": "tc_1", "name": "readFile", "input": { "path": "src/tables/haikus.ts" } }
```

#### `agentToolDone`
Agent tool execution completed.
```json
{ "event": "agentToolDone", "id": "tc_1", "name": "readFile", "result": "...", "isError": false }
```

#### `agentTurnDone`
Agent finished responding to the message.
```json
{ "event": "agentTurnDone" }
```

#### `agentError`
Agent encountered an error.
```json
{ "event": "agentError", "error": "Failed to start dev session" }
```

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

## Building a File Tree

To build a recursive file tree for the sidebar, call `listDir`
recursively. A practical approach:

1. Call `listDir` with `path: "."` to get the root.
2. For each directory entry, call `listDir` with that path.
3. Expand lazily (load subdirectories when the user opens them).
4. Listen for `fileChanged` events to update the tree incrementally.

Suggested excludes for display: `node_modules`, `.git`, `.vite`.

## Live Preview

The preview iframe points at the same domain as the C&C server, but
any path other than `/ws` and `/health`:

```html
<iframe src={`https://${cncDomain}/`} />
```

This is reverse-proxied to the dev server (via the tunnel proxy, which
injects `window.__MINDSTUDIO__` for the frontend SDK). The preview
supports HMR — edits to files trigger hot reload automatically.

The preview is available once the tunnel emits `session-started` (watch
for the `tunnelEvent` pushed event). Before that, requests return a
503 "Preview starting..." page.

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
| `API_KEY` | Developer's MindStudio API key (for tunnel) |
| `USER_ID` | Developer's user ID (for tunnel) |
| `API_BASE_URL` | Platform API URL (default: `https://api.mindstudio.ai`) |
| `WORKSPACE_DIR` | App workspace path (default: `/workspace`) |
| `PORT` | Server port (default: `4387`) |
| `SANDBOX_TOKEN` | WebSocket auth token (optional, no auth if unset) |

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
