# TypeScript Language Server — Frontend Integration

The sandbox runs a TypeScript language server (`typescript-language-server`)
that provides full IDE features: autocomplete, diagnostics, hover info,
go-to-definition, find references, rename, and code actions. It's
available over WebSocket.

## Connection

```
wss://{cncDomain}/lsp
```

No auth token required on this path. The language server is scoped to
the sandbox workspace.

## Protocol

The WebSocket carries raw JSON-RPC messages (the Language Server Protocol).
Each WebSocket message is one JSON-RPC request or response — no framing
needed on the client side.

The server handles Content-Length framing internally (between the
WebSocket bridge and the language server's stdio). You just send and
receive plain JSON.

## Required Packages

```bash
npm install monaco-languageclient vscode-ws-jsonrpc
```

These are peer dependencies of each other. `monaco-languageclient`
version 10+ works with Monaco 0.52+.

## Setup

### 1. Disable Monaco's built-in TypeScript worker

Monaco ships with a built-in TypeScript language service. It conflicts
with the real language server — you'll get duplicate diagnostics and
completions. Disable it:

```typescript
import * as monaco from 'monaco-editor';

// Disable built-in TypeScript diagnostics and suggestions
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
});
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({});

// Or more aggressively, disable the TS worker entirely:
monaco.languages.typescript.typescriptDefaults.setEagerModelSync(false);
```

### 2. Create the WebSocket connection

```typescript
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';

const ws = new WebSocket(`wss://${cncDomain}/lsp`);

ws.onopen = () => {
  const socket = toSocket(ws);
  const reader = new WebSocketMessageReader(socket);
  const writer = new WebSocketMessageWriter(socket);

  // Now create the language client (see step 3)
};
```

### 3. Create and start the language client

```typescript
import { MonacoLanguageClient } from 'monaco-languageclient';
import { CloseAction, ErrorAction } from 'vscode-languageclient';

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
```

### 4. Map file URIs

The language server works with `file://` URIs rooted at the workspace.
When opening a file in Monaco, the model URI should match:

```typescript
// When the file path from the C&C server is "dist/methods/src/generateHaiku.ts"
const uri = monaco.Uri.parse(`file:///workspace/dist/methods/src/generateHaiku.ts`);
const model = monaco.editor.createModel(content, 'typescript', uri);
```

The workspace root inside the sandbox is the `WORKSPACE_DIR` env var
(default: `/home/vercel-sandbox/workspace`). Use this as the root for
file URIs.

The language server will send diagnostics keyed by these URIs, and
features like go-to-definition will return locations using these URIs.

## Available Features

Once connected, Monaco gets these features automatically:

| Feature | LSP Method | Notes |
|---------|-----------|-------|
| Autocomplete | `textDocument/completion` | Context-aware, includes imports |
| Diagnostics | `textDocument/publishDiagnostics` | Type errors, pushed automatically |
| Hover | `textDocument/hover` | Type info on hover |
| Go to definition | `textDocument/definition` | Jump to source |
| Find references | `textDocument/references` | All usages across files |
| Rename symbol | `textDocument/rename` | Project-wide rename |
| Code actions | `textDocument/codeAction` | Quick fixes, auto-import |
| Signature help | `textDocument/signatureHelp` | Parameter hints |
| Document symbols | `textDocument/documentSymbol` | Outline view |
| Formatting | `textDocument/formatting` | If configured |

## Synchronizing File Content

The language server reads files from disk, but it also needs to know
about unsaved changes in the editor. Use `textDocument/didOpen`,
`textDocument/didChange`, and `textDocument/didClose` notifications —
`monaco-languageclient` handles these automatically as long as:

1. Models are created with correct `file://` URIs
2. The language client is started before the user begins editing

When files change on disk (e.g., from the agent or `writeFile` action),
and the file is open in the editor, update the Monaco model content.
The language client will send a `didChange` notification automatically.

## Lifecycle

- The language server starts during C&C bootstrap
- It stays running for the lifetime of the sandbox
- If the WebSocket disconnects, the language server continues running
  — the next connection reuses it
- On sandbox hibernate/resume, the language server restarts fresh
  (it rebuilds its project state from tsconfig.json on disk)

## Troubleshooting

**Duplicate completions/diagnostics**: Make sure Monaco's built-in
TypeScript worker is disabled (step 1 above).

**No completions**: Check that file URIs match the workspace path.
The language server needs `textDocument/didOpen` before it provides
features for a file.

**Slow startup**: The language server indexes the project on first
connection. Large `node_modules` can make this slow. Ensure
`tsconfig.json` has `"skipLibCheck": true` and appropriate `exclude`
patterns.
