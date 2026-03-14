# Frontend Integration Spec

How the web editor frontend should consume the C&C WebSocket API.
The frontend is a **dumb renderer** — the server owns all workspace
UI state (open tabs, active tab, expanded directories). The frontend
renders what the server tells it to and sends actions back for mutations.

---

## Connection

```typescript
const ws = new WebSocket(`wss://${cncDomain}/ws?token=${sandboxToken}`);
```

## Message Types

Every incoming WebSocket message is JSON. There are three types:

1. **Responses** — have a `requestId` field (reply to a request you sent)
2. **Events** — have an `event` field (pushed by the server)
3. **Batched events** — have `event` + `batch` array (processOutput, processStateChanged)

```typescript
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.requestId) {
    handleResponse(msg);        // reply to a request
  } else if (msg.batch) {
    handleBatchedEvent(msg);    // batched: processOutput, processStateChanged
  } else if (msg.event) {
    handleEvent(msg);           // single event
  }
};
```

---

## Init Frame

The first message after connecting. Contains everything to render the
full UI without additional requests.

```typescript
interface InitFrame {
  event: 'init';
  status: 'bootstrapping' | 'ready' | 'error';
  previewAvailable: boolean;
  app: AppConfig;                // from mindstudio.json
  fileTree: TreeEntry[];         // recursive, 3 levels deep
  chatHistory: Message[];        // from remy's session
  processes: ProcessInfo[];      // all tracked processes
  outputLog: ProcessLogEntry[];  // merged log (last 5000 lines)
  editorState: EditorState;      // tabs + expanded dirs
}
```

### EditorState

```typescript
interface EditorState {
  tabs: Array<{
    path: string;       // relative file path
    isPreview: boolean; // true = preview tab (single-click), false = pinned
  }>;
  activeTab: string | null;   // path of the focused tab
  expandedDirs: string[];     // paths of expanded directories in the file tree
}
```

**On init:** Replace your local editor state entirely with this. Render
tabs in order, highlight `activeTab`, expand directories in `expandedDirs`.

---

## Editor State Flow

The server owns tab and directory state. The frontend renders it and
sends actions to mutate it.

### Rendering Tabs

1. Render tabs from `editorState.tabs` in order
2. Highlight `editorState.activeTab`
3. Preview tabs (`isPreview: true`) should be rendered in italic or
   with a visual indicator — they get replaced by the next preview-open
4. When the active tab changes, load file content via `readFile` if
   not already loaded

### Rendering the File Tree

1. Render the initial `fileTree` from the init frame
2. A directory is expanded if its `path` is in `editorState.expandedDirs`
3. Entries with `collapsed: true` (e.g. `node_modules`) should be
   rendered as non-expandable (greyed out, no toggle arrow)
4. Hidden entries (`.git`, `.vite`, `.sandbox-state.json`) are not
   sent by the server at all

### Mutating State

Send actions — the server updates state and broadcasts
`editorStateChanged` to all clients (including you).

| User action | WS action | Params |
|------------|-----------|--------|
| Click file in tree (single) | `openFile` | `{ path, preview: true }` |
| Double-click file in tree | `openFile` | `{ path, preview: false }` |
| Click a tab | `setActiveTab` | `{ path }` |
| Close tab (X button) | `closeFile` | `{ path }` |
| Drag-reorder tabs | `reorderTabs` | `{ paths: [...] }` |
| Expand directory | `expandDir` | `{ path }` |
| Collapse directory | `collapseDir` | `{ path }` |
| Toggle directory | `toggleDir` | `{ path }` |

### Listening for Changes

The server broadcasts `editorStateChanged` whenever state changes —
from your actions, from another client, or from the agent.

```typescript
// event: editorStateChanged
{
  "event": "editorStateChanged",
  "editorState": {
    "tabs": [...],
    "activeTab": "src/App.tsx",
    "expandedDirs": ["dist", "dist/methods", "dist/methods/src"]
  }
}
```

**Always replace your local state with the broadcast.** Don't try to
merge — the server's state is authoritative.

### Agent-Driven UI

The remy agent can open files for the user (e.g. after editing a file,
open it to show the result). When this happens, you'll receive an
`editorStateChanged` with the new tab — just render it.

---

## File Tree

### Initial Load

The init frame includes a recursive `fileTree` (3 levels deep). Each
entry:

```typescript
interface TreeEntry {
  name: string;
  path: string;          // relative to workspace root
  type: 'file' | 'directory';
  size: number;
  modified: string;      // ISO timestamp
  children?: TreeEntry[];
  collapsed?: boolean;   // true = don't expand (e.g. node_modules)
}
```

### Lazy Loading

For directories beyond the initial depth, use `listDir` to load
children on demand:

```typescript
const result = await send(ws, 'listDir', { path: 'dist/methods/src/tables' });
// result.data.entries: DirEntry[]
```

`DirEntry` also has `collapsed?: boolean` for directories that
shouldn't be expanded.

### Live Updates

Listen for `fileChanged` events to update the tree incrementally:

```json
{ "event": "fileChanged", "path": "src/App.tsx", "changeType": "modified" }
```

- `created` — add the entry
- `modified` — update timestamp/size
- `deleted` — remove the entry

---

## Process Dashboard

### Initial State

`processes` in the init frame is an array of all tracked processes:

```typescript
interface ProcessInfo {
  name: string;           // "devServer", "tunnel", "agent", "bootstrap:npm-install", "shell:1710000-a3f2", "system"
  type: 'service' | 'task' | 'shell' | 'system';
  command: string;
  state: 'starting' | 'running' | 'crashed' | 'stopped' | 'completed';
  startedAt: number | null;
  endedAt: number | null;
  duration: number | null; // ms
  exitCode: number | null;
  signal: string | null;
  restartCount: number;
  restartHistory: Array<{ at: number; exitCode: number | null; signal: string | null }>;
  pid: number | null;
}
```

### Live Updates (batched)

```json
{
  "event": "processStateChanged",
  "batch": [
    { "name": "devServer", "type": "service", "prevState": "starting", "state": "running", "pid": 12345, "timestamp": 1710000000 }
  ]
}
```

Update the matching process in your local list.

### Process Output (batched)

```json
{
  "event": "processOutput",
  "batch": [
    { "process": "devServer", "stream": "stdout", "line": "VITE ready", "ts": 1710000000 },
    { "process": "system", "stream": "stderr", "line": "[cnc] error...", "ts": 1710000001 }
  ]
}
```

Append to per-process log views. `process` matches `ProcessInfo.name`.

### On-Demand Queries

- `getProcesses` — full process list refresh
- `getProcessLog` `{ name }` — per-process log buffer (up to 1000 lines)

---

## Agent Chat

### Initial History

`chatHistory` in the init frame is remy's raw LLM message format.
Render messages in order. If the agent isn't running, this is `[]`.

### Sending Messages

```typescript
await send(ws, 'agentMessage', { text: 'add a created_at field' });
```

Then listen for streaming events:

| Event | Description |
|-------|-------------|
| `agentThinking` | Internal reasoning (streaming `text` chunks) |
| `agentText` | Visible response (streaming `text` chunks) |
| `agentToolStart` | Tool started (`id`, `name`, `input`) |
| `agentToolDone` | Tool finished (`id`, `name`, `result`, `isError`) |
| `agentTurnDone` | Agent finished responding |
| `agentTurnCancelled` | Turn was cancelled |
| `agentError` | Error (`error` string) |

### Cancel / Clear

- `agentCancel` — cancel current turn (graceful, partial response saved)
- `agentClear` — clear conversation, start fresh session

---

## Tunnel Events

All events from the dev tunnel are forwarded as `tunnelEvent`:

```json
{ "event": "tunnelEvent", "event": "session-started", "sessionId": "...", "proxyPort": 3835, "scenarios": [...] }
```

Key events to handle:

| Event | Frontend action |
|-------|----------------|
| `session-started` | Enable preview iframe, populate scenario picker from `scenarios` |
| `schema-synced` | Show sync result (tables created/altered/errors) |
| `scenario-start` | Show "running scenario..." indicator |
| `scenario-complete` | Update scenario state, show success/failure |
| `scenarios-list` | Refresh scenario picker |
| `impersonated` | Update current role display (`roles` array or `null`) |
| `roles-list` | Populate role picker |
| `method-start` / `method-complete` | Show method execution in activity log |
| `connection-warning` | Show connection lost banner |
| `connection-restored` | Clear connection lost banner |
| `session-expired` | Show session expired state |

### Tunnel Actions

| Action | Params | Listen for |
|--------|--------|------------|
| `tunnelRunScenario` | `{ scenarioId }` | `scenario-start`, `scenario-complete` |
| `tunnelSyncSchema` | `{}` | `schema-synced` |
| `tunnelListScenarios` | `{}` | `scenarios-list` |
| `tunnelImpersonate` | `{ roles: string[] }` | `impersonated` |
| `tunnelClearImpersonation` | `{}` | `impersonated` (roles=null) |
| `tunnelListRoles` | `{}` | `roles-list` |

---

## Live Preview

```html
<iframe src={`https://${cncDomain}/`} />
```

Available once `tunnelEvent` with `session-started` arrives. Before
that, the server returns a 503 "Preview starting..." page.

The preview supports HMR — file edits trigger hot reload automatically.

---

## Bootstrap Progress

During initial setup, listen for:

```json
{ "event": "bootstrapProgress", "step": "installDeps", "message": "Installing dependencies..." }
```

Steps in order: `installTunnel`, `installAgent`, `installLsp`,
`cloneApp`, `installDeps`, `devServer`, `tunnel`, `agent`, `ready`,
`error`. Show a progress indicator until `ready` or `error`.
