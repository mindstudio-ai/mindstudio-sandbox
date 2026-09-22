/**
 * LSP Client — JSON-RPC multiplexer for the TypeScript language server.
 *
 * Owns the language server process and provides a typed API for sending
 * requests and receiving notifications. Multiple consumers (Monaco via
 * WebSocket, remy via HTTP sidecar) share the same language server instance.
 *
 * Because the server is shared, this class is the ONLY thing that ever sends
 * `initialize`. typescript-language-server has no re-entry guard: every
 * `initialize` it receives spawns another tsserver and orphans the previous
 * one (RPT-1213 — a sandbox filled its 4 GB with leaked tsservers, one per
 * editor page load, and livelocked). The WebSocket bridge answers Monaco's
 * lifecycle messages locally from `getInitializeResult()`.
 *
 * The server is also allowed to die. tsserver can be OOM-killed or abort on
 * its heap cap (see `initializationOptions`), and when it does the language
 * server survives as a zombie that answers every request with nothing — so
 * this client watches for that and relaunches the whole server, with a
 * bounded restart budget.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcessRegistry } from '../processes/ProcessRegistry.ts';
import { attachLineHandler } from '../processes/lineSplitter.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('lsp/client');

type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB — safety cap on LSP message buffer
const REQUEST_TIMEOUT_MS = 30_000; // 30s — reject hung requests

/**
 * V8 old-space cap for tsserver, in MB. The sandbox VM is 4 GB with roughly
 * 1 GB of other residents (Chrome, remy, tunnel, C&C, Vite) plus build/git
 * spikes. A heap cap makes tsserver fail cleanly (abort → relaunch below)
 * instead of dragging the whole VM into memory livelock. tsls's own default
 * is 3072, which on this box is indistinguishable from "unbounded".
 */
const MAX_TSSERVER_MEMORY_MB = 1536;

/**
 * Relaunch backoff after an unexpected exit, indexed by consecutive attempt.
 * Budget: at most MAX_RESTARTS within RESTART_WINDOW_MS, then stay crashed —
 * a project that genuinely can't fit under the heap cap should fail loudly
 * in lsp.log, not restart forever.
 */
const RESTART_DELAYS_MS = [2_000, 10_000, 30_000];
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

/** tsls logs this (via window/logMessage, severity Error) when its tsserver
 * child exits. Prefixes nest (`[lspserver] [tsclient] [tsserver] Exited. …`),
 * so match the tail, not the start. */
const TSSERVER_EXITED_RE = /\[tsserver\] Exited\./;

/**
 * Absolute path to the globally-installed TypeScript's `tsserver.js`, or null.
 *
 * typescript-language-server resolves TypeScript from the workspace by default,
 * but nothing installs a workspace-root `typescript` — it's installed globally
 * alongside the language server (see bootstrap `installLsp`). Pinning
 * `tsserver.path` to that global copy removes reliance on resolution heuristics,
 * which is what surfaces as `-32603 Could not find a valid TypeScript
 * installation` when the heuristics come up empty. Best-effort: returns null
 * (→ let the server resolve on its own) if the global copy can't be located.
 *
 * TWO prefixes, in PATH order, because the box has two. `npm root -g` reports only
 * NPM_CONFIG_PREFIX, which the image points at a user-writable prefix under remy's home so that an
 * agent can `npm install -g` — while the baked toolchain was installed before that ENV took effect
 * and sits under node's own prefix. Asking npm alone therefore missed the pin on 100% of boots, and
 * silently: the fallback path works, on whatever TypeScript major the language server bundles
 * rather than the one the image pinned.
 */
async function resolveGlobalTsserverPath(): Promise<string | null> {
  const roots: string[] = [];
  try {
    roots.push(execSync('npm root -g', { encoding: 'utf-8' }).trim());
  } catch {
    // npm unavailable or misconfigured; the default prefix below is still worth a look.
  }
  // npm's default global prefix IS node's install prefix, so derive it from the running binary
  // rather than naming a path the image is free to move.
  roots.push(
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules'),
  );

  for (const root of new Set(roots)) {
    const tsserver = path.join(root, 'typescript', 'lib', 'tsserver.js');
    try {
      await fs.access(tsserver);
      return tsserver;
    } catch {
      // Not in this prefix; try the next.
    }
  }
  return null;
}

export class LspClient {
  private process: ChildProcess | null = null;
  private workspaceDir: string = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private openFiles = new Set<string>();
  private fileVersions = new Map<string, number>();
  private buffer = Buffer.alloc(0);
  private registry: ProcessRegistry | null = null;
  /** The server's `initialize` response — handed to bridge clients so they
   * never send their own `initialize`. Null while the server is down. */
  private initializeResult: unknown | null = null;
  /** Set by `stop()`: an exit after this is deliberate, not a crash. */
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Timestamps of relaunches inside the current budget window. */
  private restartTimes: number[] = [];
  /**
   * Fires after a successful relaunch. The server has a fresh, empty document
   * state at that point, so the WebSocket bridge uses this to close every
   * Monaco client (1012) and let them reconnect and re-announce their files.
   */
  onRelaunched: (() => void) | null = null;

  constructor() {
    // Registered once for the client's lifetime (not per launch — relaunches
    // would otherwise stack duplicate handlers and duplicate log lines).
    this.onNotification('window/logMessage', (params) => {
      const p = params as { type: number; message: string };
      // LSP log types: 1=Error, 2=Warning, 3=Info, 4=Log
      const level = p.type <= 2 ? 'error' : 'info';
      this.registry?.appendLog('lsp', p.message, { level });

      // tsserver died underneath a still-running language server. tsls only
      // throws (and takes the LS down with it) for a truthy exit code; SIGKILL
      // from the OOM killer and SIGABRT from the V8 heap cap both leave code
      // null, so the LS lives on answering every request with nothing. Kill
      // it and let the exit handler relaunch the pair.
      if (
        TSSERVER_EXITED_RE.test(p.message) &&
        this.process &&
        !this.stopping
      ) {
        const detail = p.message.slice(p.message.indexOf('Exited.')).trim();
        log.error(`tsserver died (${detail}) — restarting language server`);
        this.registry?.appendLog(
          'lsp',
          `tsserver died (${detail}) — restarting language server`,
          { level: 'error' },
        );
        this.process.kill();
      }
    });
  }

  async start(workspaceDir: string, registry?: ProcessRegistry): Promise<void> {
    this.registry = registry ?? null;
    this.workspaceDir = workspaceDir;
    this.stopping = false;

    // Register in process registry for dashboard visibility. Once per client:
    // re-registering on relaunch would wipe the entry's restart history.
    this.registry?.register(
      'lsp',
      'service',
      'typescript-language-server --stdio',
    );

    await this.launch();
  }

  /** Spawn the server and run the `initialize` handshake. */
  private async launch(): Promise<void> {
    log.info(
      `Starting typescript-language-server --stdio (cwd: ${this.workspaceDir})`,
    );
    // crashed → starting is the transition ProcessRegistry counts as a restart.
    this.registry?.setState('lsp', 'starting');

    const child = spawn('typescript-language-server', ['--stdio'], {
      cwd: this.workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    this.buffer = Buffer.alloc(0);

    log.info(`Spawned with PID ${child.pid}`);
    this.registry?.setState('lsp', 'running', { pid: child.pid ?? null });

    if (child.stderr) {
      attachLineHandler(child.stderr, (line) => {
        log.debug(`stderr: ${line}`);
        this.registry?.appendLog('lsp', line);
      });
    }

    // Every listener checks it still belongs to the live process so a stale
    // event from a dead child can't disturb its replacement.
    child.on('error', (err) => {
      if (this.process !== child) {
        return;
      }
      log.error(`Spawn error: ${err.message}`);
      this.handleExit(null, null);
    });

    child.on('exit', (code, signal) => {
      if (this.process !== child) {
        return;
      }
      log.info(`Exited (code=${code}, signal=${signal})`);
      this.handleExit(code, signal);
    });

    // Parse Content-Length framed messages from stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.process !== child) {
        return;
      }
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_BUFFER_SIZE) {
        log.error(
          `Message buffer exceeded ${MAX_BUFFER_SIZE} bytes, dropping buffer`,
        );
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.drainBuffer();
    });

    // Send initialize request
    const rootUri = `file://${this.workspaceDir}`;
    log.debug(`Sending initialize (rootUri: ${rootUri})`);

    // Pin the server at the globally-installed TypeScript so init doesn't depend
    // on the workspace resolving a `typescript` it never installs at its root.
    const tsserverPath = await resolveGlobalTsserverPath();
    if (tsserverPath) {
      log.info(`Pinning tsserver.path to global TypeScript: ${tsserverPath}`);
    } else {
      log.warn(
        'Global TypeScript not located; letting the server resolve TypeScript on its own',
      );
    }

    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri,
      initializationOptions: {
        // See MAX_TSSERVER_MEMORY_MB. Passed to tsserver as --max-old-space-size.
        maxTsServerMemory: MAX_TSSERVER_MEMORY_MB,
        // The box already has its node_modules; no background npm typings
        // downloads competing for the same 2 vCPUs.
        disableAutomaticTypingAcquisition: true,
        tsserver: {
          ...(tsserverPath ? { path: tsserverPath } : {}),
          // One tsserver process, not a syntax+semantic pair. Fewer processes
          // beats slightly faster syntax-only requests on a 2 vCPU box.
          useSyntaxServer: 'never',
        },
      },
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
            dynamicRegistration: false,
          },
          completion: {
            completionItem: {
              snippetSupport: true,
              resolveSupport: { properties: ['documentation', 'detail'] },
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          definition: {},
          references: {},
          documentSymbol: {},
          codeAction: {},
          rename: { prepareSupport: true },
          publishDiagnostics: {},
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: [
        { uri: rootUri, name: path.basename(this.workspaceDir) },
      ],
    });

    log.debug('Initialize response received');
    this.initializeResult = result;

    // Send initialized notification
    this.notify('initialized', {});

    log.info('Ready');
  }

  /** Shared teardown for a process that is gone, deliberate or not. */
  private handleExit(code: number | null, signal: string | null): void {
    this.process = null;
    this.buffer = Buffer.alloc(0);
    this.initializeResult = null;
    // Consumers reopen lazily (ensureFileOpen / updateFileContent), and the
    // bridge clients get closed on relaunch so they re-announce theirs.
    this.openFiles.clear();
    this.fileVersions.clear();
    for (const [id, req] of this.pending) {
      req.reject(new Error('Language server exited'));
      this.pending.delete(id);
    }

    if (this.stopping) {
      this.registry?.setState('lsp', 'stopped', {
        exitCode: code,
        signal: signal ?? undefined,
      });
      return;
    }

    this.registry?.setState('lsp', 'crashed', {
      exitCode: code,
      signal: signal ?? undefined,
    });
    this.scheduleRelaunch();
  }

  private scheduleRelaunch(): void {
    if (this.restartTimer || this.stopping) {
      return;
    }
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter(
      (t) => now - t < RESTART_WINDOW_MS,
    );
    if (this.restartTimes.length >= MAX_RESTARTS) {
      const msg = `Language server crashed ${MAX_RESTARTS} times in ${RESTART_WINDOW_MS / 60_000} minutes — giving up (no code intelligence until the sandbox restarts)`;
      log.error(msg);
      this.registry?.appendLog('lsp', msg, { level: 'error' });
      return;
    }
    const attempt = this.restartTimes.length;
    const delay =
      RESTART_DELAYS_MS[Math.min(attempt, RESTART_DELAYS_MS.length - 1)];
    this.restartTimes.push(now);
    log.warn(
      `Relaunching language server in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RESTARTS})`,
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.relaunch();
    }, delay);
  }

  private async relaunch(): Promise<void> {
    if (this.stopping) {
      return;
    }
    try {
      await this.launch();
      log.info('Language server relaunched');
      this.onRelaunched?.();
    } catch (err) {
      log.error(
        `Relaunch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (this.process) {
        // A live process that couldn't initialize is useless — kill it and let
        // the exit handler schedule the next attempt against the budget.
        this.process.kill();
      } else {
        this.scheduleRelaunch();
      }
    }
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.process;
    if (child) {
      log.info('Stopping...');
      // Let go of the child first so its exit handler ignores it (and never
      // schedules a relaunch), then record the deliberate stop ourselves.
      this.process = null;
      child.kill();
      this.registry?.setState('lsp', 'stopped');
    }
    this.initializeResult = null;
    this.openFiles.clear();
    this.fileVersions.clear();
    this.pending.clear();
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /** The server's `initialize` result, or null while it is down. */
  getInitializeResult(): unknown | null {
    return this.initializeResult;
  }

  // --- JSON-RPC ---

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('Language server not running'));
        return;
      }

      const id = this.nextId++;

      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(
              `LSP request ${method} timed out after ${REQUEST_TIMEOUT_MS}ms`,
            ),
          );
        }
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      this.writeMessage(message);
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.process?.stdin) {
      return;
    }

    // Track file state from notifications
    if (method === 'textDocument/didOpen') {
      const p = params as { textDocument: { uri: string } };
      this.openFiles.add(p.textDocument.uri);
    } else if (method === 'textDocument/didClose') {
      const p = params as { textDocument: { uri: string } };
      this.openFiles.delete(p.textDocument.uri);
      this.fileVersions.delete(p.textDocument.uri);
    }

    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.writeMessage(message);
  }

  onNotification(method: string, handler: NotificationHandler): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);

    // Return unsubscribe function
    return () => {
      handlers!.delete(handler);
    };
  }

  // --- File state management ---

  isFileOpen(uri: string): boolean {
    return this.openFiles.has(uri);
  }

  /** Open a file in the language server. No-op if already open. */
  async ensureFileOpen(relativePath: string): Promise<string> {
    const uri = this.pathToUri(relativePath);

    if (this.openFiles.has(uri)) {
      return uri;
    }

    const absPath = path.join(this.workspaceDir, relativePath);
    const content = await fs.readFile(absPath, 'utf-8');
    const languageId = this.detectLanguage(relativePath);

    this.fileVersions.set(uri, 1);
    this.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    });

    return uri;
  }

  /** Update file content in the language server. Opens first if needed. */
  async updateFileContent(
    relativePath: string,
    content?: string,
  ): Promise<string> {
    const uri = this.pathToUri(relativePath);

    if (!this.openFiles.has(uri)) {
      return this.ensureFileOpen(relativePath);
    }

    if (!content) {
      const absPath = path.join(this.workspaceDir, relativePath);
      content = await fs.readFile(absPath, 'utf-8');
    }

    const version = (this.fileVersions.get(uri) || 1) + 1;
    this.fileVersions.set(uri, version);

    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    });

    return uri;
  }

  /** Close a file in the language server. No-op if not open. */
  closeFile(relativePath: string): void {
    const uri = this.pathToUri(relativePath);
    if (!this.openFiles.has(uri)) {
      return;
    }
    this.notify('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  // --- Helpers ---

  pathToUri(relativePath: string): string {
    return `file://${path.join(this.workspaceDir, relativePath)}`;
  }

  uriToPath(uri: string): string {
    const prefix = `file://${this.workspaceDir}/`;
    if (uri.startsWith(prefix)) {
      return uri.slice(prefix.length);
    }
    // Fall back to stripping file:// and making relative
    if (uri.startsWith('file://')) {
      return path.relative(this.workspaceDir, uri.slice(7));
    }
    return uri;
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath);
    switch (ext) {
      case '.ts':
        return 'typescript';
      case '.tsx':
        return 'typescriptreact';
      case '.js':
        return 'javascript';
      case '.jsx':
        return 'javascriptreact';
      case '.json':
        return 'json';
      default:
        return 'plaintext';
    }
  }

  private writeMessage(json: string): void {
    if (!this.process?.stdin) {
      return;
    }
    const content = Buffer.from(json, 'utf-8');
    const header = `Content-Length: ${content.length}\r\n\r\n`;
    this.process.stdin.write(header);
    this.process.stdin.write(content);
  }

  private drainBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        break;
      }

      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = header.match(/Content-Length: (\d+)/);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) {
        break;
      }

      const messageBytes = this.buffer.subarray(
        messageStart,
        messageStart + contentLength,
      );
      this.buffer = this.buffer.subarray(messageStart + contentLength);

      try {
        const message = JSON.parse(messageBytes.toString());
        this.handleMessage(message);
      } catch (err) {
        log.error(
          `Failed to parse message: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private handleMessage(message: {
    id?: number;
    method?: string;
    result?: unknown;
    error?: { code: number; message: string };
    params?: unknown;
  }): void {
    if (message.id !== undefined && this.pending.has(message.id)) {
      // Response to a request we sent
      const req = this.pending.get(message.id)!;
      this.pending.delete(message.id);

      if (message.error) {
        req.reject(
          new Error(
            `LSP error ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        req.resolve(message.result);
      }
    } else if (message.method) {
      // Server-initiated notification or request
      const handlers = this.notificationHandlers.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params);
          } catch (err) {
            log.error(
              `Notification handler error for ${message.method}: ${err}`,
            );
          }
        }
      }

      // If it's a server request (has id), we need to respond
      if (message.id !== undefined) {
        // Most server requests can be answered with null
        this.writeMessage(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result: null }),
        );
      }
    }
  }
}
