/**
 * LSP Client — JSON-RPC multiplexer for the TypeScript language server.
 *
 * Owns the language server process and provides a typed API for sending
 * requests and receiving notifications. Multiple consumers (Monaco via
 * WebSocket, remy via HTTP sidecar) share the same language server instance.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcessRegistry } from '../processes/process-registry.js';
import { createLogger } from '../logger.js';

const log = createLogger('lsp-client');

type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB — safety cap on LSP message buffer
const REQUEST_TIMEOUT_MS = 30_000; // 30s — reject hung requests

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

  async start(workspaceDir: string, registry?: ProcessRegistry): Promise<void> {
    this.registry = registry ?? null;
    this.workspaceDir = workspaceDir;

    log.info(
      `Starting typescript-language-server --stdio (cwd: ${workspaceDir})`,
    );

    this.process = spawn('typescript-language-server', ['--stdio'], {
      cwd: workspaceDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    log.info(`Spawned with PID ${this.process.pid}`);

    // Register in process registry for dashboard visibility
    this.registry?.register(
      'lsp',
      'service',
      'typescript-language-server --stdio',
    );
    this.registry?.setState('lsp', 'running', {
      pid: this.process.pid ?? null,
    });

    if (this.process.stderr) {
      const rl = createInterface({ input: this.process.stderr });
      rl.on('line', (line) => {
        log.debug(`stderr: ${line}`);
        this.registry?.appendLog('lsp', 'stderr', line);
      });
    }

    this.process.on('error', (err) => {
      log.error(`Spawn error: ${err.message}`);
      this.registry?.setState('lsp', 'crashed');
      this.process = null;
    });

    this.process.on('exit', (code, signal) => {
      log.info(`Exited (code=${code}, signal=${signal})`);
      this.registry?.setState('lsp', 'stopped', {
        exitCode: code,
        signal: signal ?? undefined,
      });
      this.process = null;
      // Reject all pending requests
      for (const [id, req] of this.pending) {
        req.reject(new Error('Language server exited'));
        this.pending.delete(id);
      }
    });

    // Parse Content-Length framed messages from stdout
    this.process.stdout?.on('data', (chunk: Buffer) => {
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
    const rootUri = `file://${workspaceDir}`;
    log.debug(`Sending initialize (rootUri: ${rootUri})`);

    const initResult = await this.request('initialize', {
      processId: process.pid,
      rootUri,
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
      workspaceFolders: [{ uri: rootUri, name: path.basename(workspaceDir) }],
    });

    log.debug('Initialize response received');

    // Send initialized notification
    this.notify('initialized', {});

    // Route LSP server log messages to the process registry
    this.onNotification('window/logMessage', (params) => {
      const p = params as { type: number; message: string };
      // LSP log types: 1=Error, 2=Warning, 3=Info, 4=Log
      const stream = p.type <= 2 ? 'stderr' : 'stdout';
      this.registry?.appendLog('lsp', stream, p.message);
    });

    log.info('Ready');
  }

  stop(): void {
    if (this.process) {
      log.info('Stopping...');
      this.process.kill();
      this.process = null;
    }
    this.openFiles.clear();
    this.fileVersions.clear();
    this.pending.clear();
  }

  get isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
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
