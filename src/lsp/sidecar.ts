/**
 * LSP Sidecar — HTTP API for the remy agent to access the TypeScript
 * language server. Wraps LSP complexity behind simple REST endpoints.
 *
 * Shares the same language server instance as Monaco (via LspClient).
 */

import http from 'node:http';
import type { LspClient } from './client.ts';
import type { ProcessManager } from '../processes/ProcessManager.ts';
import {
  sendCommand as sendTunnelCommand,
  startRecordingExport,
} from '../processes/tunnel/index.ts';
import type { RecordingExportRequest } from '../processes/tunnel/index.ts';
import { createLogger } from '../logger.ts';

const log = createLogger('lsp/sidecar');

interface DiagnosticItem {
  file: string;
  line: number;
  column: number;
  severity: string;
  message: string;
  code: number | string | undefined;
}

// Timeouts for browser commands relayed to the tunnel.
//
// These are the middle rung of a three-layer ladder, and the ladder only works
// if every layer is strictly slower than the one it wraps — that way the
// innermost layer, which knows *what* was slow, is always the one that reports
// the failure. When two rungs matched, the outer timer won (it started first) and
// the caller got a bare "timeout (Ns)" with no error code and none of the partial
// results, which is exactly what made a slow page look like broken plumbing.
//
//   tunnel                          this file            remy
//   viewport capture       20s   <  30s              <  45s
//   full-page capture      90s   <  120s             <  135s
//   setup-browser          15s   <  25s              <  30s
//   whole browser command  100s  <  120s                 (no timer; owned here)
//   replay export          450s  <  600s             <  660s (remy-admin CLI)
//
// See src/devTunnel/browser/screenshot.ts and
// src/devTunnel/stdin-commands/browser.ts for the inner values. The setup-browser
// handler's inner rung is its 15s page.goto (setup-browser.ts) — this rung
// used to match it at 15s, so the caller saw a bare "timeout (15s)" instead
// of the navigation error that names the path and the cause.
const SCREENSHOT_VIEWPORT_TIMEOUT_MS = 30_000;
const SCREENSHOT_FULLPAGE_TIMEOUT_MS = 120_000;
const SETUP_BROWSER_TIMEOUT_MS = 25_000;

// Exceeds the 15s page.reload inside the supervisor's setPreviewMode.
const SET_VIEWPORT_TIMEOUT_MS = 20_000;
// A replay render plays the clip in real time, then encodes and uploads it.
// `startRecordingExport` applies its own 600s rung to the stdin command, so
// this only has to be no tighter than that; it also sets the server's
// `requestTimeout` above.
const EXPORT_RECORDING_TIMEOUT_MS = 600_000;
// ---------------------------------------------------------------------------
// Request-body narrowing
//
// Every route here is reached over HTTP with a JSON body, so each field is
// `unknown` until checked. These used to be spread straight into tunnel
// commands; the typed protocol is what surfaced that. The tunnel validates its
// own inputs too and still should — this is the near end of the same check,
// and it is what lets a bad body fail here with a useful message instead of
// travelling one process further to be rejected.
// ---------------------------------------------------------------------------

const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

const asNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const asBoolean = (v: unknown): boolean | undefined =>
  typeof v === 'boolean' ? v : undefined;

const asImageFormat = (v: unknown): 'png' | 'jpeg' | undefined =>
  v === 'png' || v === 'jpeg' ? v : undefined;

const asPreviewMode = (v: unknown): 'desktop' | 'mobile' | undefined =>
  v === 'desktop' || v === 'mobile' ? v : undefined;

/** `{ k: v }` when v is defined, `{}` otherwise — keeps the spread idiom. */
const opt = <K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

const SEVERITY_MAP: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
};

const SYMBOL_KIND_MAP: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enumMember',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'typeParameter',
};

const MAX_DIAGNOSTICS_CACHE = 200;

// Diagnostic codes to suppress regardless of severity — these are style
// suggestions that mislead the LLM into "fixing" things that aren't broken.
const SUPPRESSED_CODES = new Set<number | string>([
  6133, // 'X' is declared but its value is never read
  6196, // 'X' is declared but never used
  80005, // 'require' call may be converted to an import
  80006, // This may be converted to an async function
]);

export class LspSidecar {
  private server: http.Server | null = null;
  private lsp: LspClient;
  private pm: ProcessManager | null = null;
  private diagnosticsCache = new Map<string, DiagnosticItem[]>();

  constructor(lspClient: LspClient) {
    this.lsp = lspClient;

    // Listen for all diagnostics and cache them
    this.lsp.onNotification(
      'textDocument/publishDiagnostics',
      (params: unknown) => {
        const p = params as {
          uri: string;
          diagnostics: Array<{
            range: { start: { line: number; character: number } };
            severity?: number;
            message: string;
            code?: number | string;
          }>;
        };
        const relPath = this.lsp.uriToPath(p.uri);
        this.diagnosticsCache.set(
          relPath,
          p.diagnostics
            .filter((d) => {
              // Drop hints and informational diagnostics — they're noise for LLMs
              const sev = d.severity ?? 1;
              if (sev >= 3) {
                return false;
              }
              // Drop specific codes that mislead the agent into unnecessary fixes
              if (d.code !== undefined && SUPPRESSED_CODES.has(d.code)) {
                return false;
              }
              return true;
            })
            .map((d) => ({
              file: relPath,
              line: d.range.start.line + 1, // LSP is 0-indexed
              column: d.range.start.character + 1,
              severity: SEVERITY_MAP[d.severity ?? 1] || 'error',
              message: d.message,
              code: d.code,
            })),
        );
        // Evict oldest entries if cache is too large
        if (this.diagnosticsCache.size > MAX_DIAGNOSTICS_CACHE) {
          const oldest = this.diagnosticsCache.keys().next().value!;
          this.diagnosticsCache.delete(oldest);
        }
      },
    );
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer(async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        // Read body
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        let params: Record<string, unknown>;
        try {
          params = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        try {
          let result: unknown;
          switch (req.url) {
            case '/diagnostics':
              result = await this.handleDiagnostics(params);
              break;
            case '/definition':
              result = await this.handleDefinition(params);
              break;
            case '/references':
              result = await this.handleReferences(params);
              break;
            case '/hover':
              result = await this.handleHover(params);
              break;
            case '/symbols':
              result = await this.handleSymbols(params);
              break;
            case '/restart-process':
              result = await this.handleRestartProcess(params);
              break;
            case '/setup-browser':
              result = this.pm
                ? await sendTunnelCommand(
                    this.pm,
                    'setup-browser',
                    {
                      // `auth` is a nested object the tunnel re-validates; the
                      // shape check here is just "is it an object at all".
                      ...(params.auth && typeof params.auth === 'object'
                        ? {
                            auth: params.auth as {
                              email?: string;
                              phone?: string;
                              roles?: string[];
                            },
                          }
                        : {}),
                      ...opt('path', asString(params.path)),
                    },
                    SETUP_BROWSER_TIMEOUT_MS,
                  )
                : { success: false, error: 'tunnel not available' };
              break;
            case '/screenshot-full-page':
              result = this.pm
                ? await sendTunnelCommand(
                    this.pm,
                    'screenshotFullPage',
                    {
                      ...opt('path', asString(params.path)),
                      ...opt('format', asImageFormat(params.format)),
                    },
                    SCREENSHOT_FULLPAGE_TIMEOUT_MS,
                  )
                : { url: '', width: 0, height: 0, duration: 0 };
              break;
            case '/screenshot-viewport':
              // Viewport captures skip the full-page pre-roll scroll, so they
              // settle far faster — a tighter timeout is enough.
              result = this.pm
                ? await sendTunnelCommand(
                    this.pm,
                    'screenshotViewport',
                    {
                      ...opt('path', asString(params.path)),
                      ...opt('width', asNumber(params.width)),
                      ...opt('height', asNumber(params.height)),
                      ...opt('format', asImageFormat(params.format)),
                    },
                    SCREENSHOT_VIEWPORT_TIMEOUT_MS,
                  )
                : { url: '', width: 0, height: 0, duration: 0 };
              break;
            case '/render-html':
              // Render an agent-authored HTML document in a fresh browser tab
              // and capture it as a PNG at exact dimensions (deterministic
              // brand graphics: share cards, wordmarks, flat icon tiles).
              // Viewport-class timeout — no navigation, no pre-roll.
              result = this.pm
                ? await sendTunnelCommand(
                    this.pm,
                    'renderHtml',
                    {
                      // Required by the protocol, so they are checked here
                      // rather than sent hollow for the tunnel to reject one
                      // process later. Its own validator still runs — it owns
                      // the min/max dimension bounds.
                      html: asString(params.html) ?? '',
                      width: asNumber(params.width) ?? 0,
                      height: asNumber(params.height) ?? 0,
                      ...opt('transparent', asBoolean(params.transparent)),
                      ...opt('scale', asNumber(params.scale)),
                    },
                    SCREENSHOT_VIEWPORT_TIMEOUT_MS,
                  )
                : { success: false, error: 'tunnel not available' };
              break;
            case '/export-recording':
              // Render a QA replay to an mp4 and answer with where it landed.
              // This is what `remy-admin qa-recordings export` calls, which is how
              // the agent reaches it — the capability is a CLI command rather
              // than a tool, so it costs nothing in the prompt.
              //
              // Unlike the editor's WS path this does NOT refuse while the
              // agent is busy: the agent is the caller, and it is blocked here
              // for the duration (see startRecordingExport).
              result = this.pm
                ? await startRecordingExport(
                    this.pm,
                    params as unknown as RecordingExportRequest,
                    { requireIdleAgent: false, awaitResult: true },
                  )
                : { success: false, error: 'tunnel not available' };
              break;
            case '/set-viewport':
              // Reuse the `browser` command with a single setViewport step so
              // there's no separate tunnel handler. `mode` is 'desktop' |
              // 'mobile' | 'default' ('default' → the app's defaultPreviewMode);
              // remy's per-run reset passes 'default'.
              result = this.pm
                ? await sendTunnelCommand(
                    this.pm,
                    'browser',
                    {
                      steps: [
                        {
                          command: 'setViewport',
                          mode: asPreviewMode(params.mode) ?? 'default',
                        },
                      ],
                    },
                    SET_VIEWPORT_TIMEOUT_MS,
                  )
                : { success: false, error: 'tunnel not available' };
              break;
            default:
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Not found' }));
              return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          log.error(
            `Error handling ${req.url}: ${err instanceof Error ? err.message : err}`,
          );
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Unknown error',
            }),
          );
        }
      });

      // Node's default `requestTimeout` is 5 minutes, which is shorter than a
      // replay render is allowed to take (`/export-recording` holds its request
      // open for the whole job). Raise it past that rung of the ladder so the
      // tunnel's own error is what the caller sees, never a severed socket.
      this.server.requestTimeout = EXPORT_RECORDING_TIMEOUT_MS + 30_000;

      this.server.listen(port, () => {
        log.info(`Listening on port ${port}`);
        resolve();
      });
    });
  }

  setProcessManager(pm: ProcessManager): void {
    this.pm = pm;
  }

  stop(): void {
    this.server?.close();
  }

  /** Notify the sidecar that a file changed on disk. */
  async onFileChanged(relativePath: string): Promise<void> {
    if (this.lsp.isFileOpen(this.lsp.pathToUri(relativePath))) {
      await this.lsp.updateFileContent(relativePath);
    }
  }

  /** Notify the sidecar that a file was deleted. */
  onFileDeleted(relativePath: string): void {
    this.lsp.closeFile(relativePath);
  }

  // --- Endpoint handlers ---

  private async handleRestartProcess(
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    const name = params.name as string;
    if (!name) {
      throw new Error('Missing "name" parameter');
    }
    if (!this.pm) {
      throw new Error('Process manager not available');
    }
    log.info('Restarting process', { name });
    // The methods worker is forked inside the tunnel, not a ProcessManager
    // process — relay to the tunnel, which kills it; the next method run
    // respawns it fresh (picking up e.g. a newly installed SDK).
    if (name === 'methodsWorker') {
      const result = await sendTunnelCommand(
        this.pm,
        'restart-worker',
        {},
        10_000,
      );
      if (result.success === false) {
        throw new Error(
          `Failed to restart methods worker: ${result.error ?? 'unknown error'}`,
        );
      }
      return { ok: true };
    }
    if (name === 'devServer') {
      await sendTunnelCommand(this.pm!, 'dev-server-restarting', {}, 5_000);
    }
    const restarted = await this.pm.restart(name);
    if (!restarted) {
      throw new Error(
        `Unknown process "${name}" — known: devServer, methodsWorker`,
      );
    }
    return { ok: true };
  }

  private async handleDiagnostics(
    params: Record<string, unknown>,
  ): Promise<{ diagnostics: DiagnosticItem[] }> {
    const file = params.file as string;
    if (!file) {
      throw new Error('Missing "file" parameter');
    }

    // Open/update the file so the language server analyzes it
    await this.lsp.updateFileContent(file);

    // Clear stale cache — we just sent a didChange, so any cached diagnostics
    // are from the previous version. Without this, waitForDiagnostics starts a
    // premature settle timer from the stale cache and returns old errors before
    // the LSP has time to re-analyze.
    this.diagnosticsCache.delete(file);

    // Wait for diagnostics to settle (the LSP pushes them asynchronously)
    const diagnostics = await this.waitForDiagnostics(file, 5000, 800);
    return { diagnostics };
  }

  private async handleDefinition(params: Record<string, unknown>): Promise<{
    definitions: Array<{ file: string; line: number; column: number }>;
  }> {
    const file = params.file as string;
    const line = params.line as number;
    const column = params.column as number;
    if (!file || line === undefined || column === undefined) {
      throw new Error('Missing "file", "line", or "column" parameter');
    }

    const uri = await this.lsp.ensureFileOpen(file);
    const result = (await this.lsp.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    })) as
      | { uri: string; range: { start: { line: number; character: number } } }
      | Array<{
          uri: string;
          range: { start: { line: number; character: number } };
        }>
      | null;

    if (!result) {
      return { definitions: [] };
    }

    const locations = Array.isArray(result) ? result : [result];
    return { definitions: this.mapLocations(locations) };
  }

  private async handleReferences(params: Record<string, unknown>): Promise<{
    references: Array<{ file: string; line: number; column: number }>;
  }> {
    const file = params.file as string;
    const line = params.line as number;
    const column = params.column as number;
    if (!file || line === undefined || column === undefined) {
      throw new Error('Missing "file", "line", or "column" parameter');
    }

    const uri = await this.lsp.ensureFileOpen(file);
    const result = (await this.lsp.request('textDocument/references', {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    })) as Array<{
      uri: string;
      range: { start: { line: number; character: number } };
    }> | null;

    if (!result) {
      return { references: [] };
    }

    return { references: this.mapLocations(result) };
  }

  private async handleHover(
    params: Record<string, unknown>,
  ): Promise<{ type: string; documentation: string }> {
    const file = params.file as string;
    const line = params.line as number;
    const column = params.column as number;
    if (!file || line === undefined || column === undefined) {
      throw new Error('Missing "file", "line", or "column" parameter');
    }

    const uri = await this.lsp.ensureFileOpen(file);
    const result = (await this.lsp.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    })) as {
      contents:
        | string
        | { kind: string; value: string }
        | Array<string | { kind: string; value: string }>;
    } | null;

    if (!result) {
      return { type: '', documentation: '' };
    }

    // Extract text from various hover content formats
    const contents = result.contents;
    let type = '';
    let documentation = '';

    if (typeof contents === 'string') {
      type = contents;
    } else if (Array.isArray(contents)) {
      for (const item of contents) {
        const text = typeof item === 'string' ? item : item.value;
        if (!type) {
          type = text;
        } else {
          documentation += (documentation ? '\n' : '') + text;
        }
      }
    } else if (contents && typeof contents === 'object') {
      type = contents.value;
    }

    return { type, documentation };
  }

  private async handleSymbols(params: Record<string, unknown>): Promise<{
    symbols: Array<{ name: string; kind: string; line: number }>;
  }> {
    const file = params.file as string;
    if (!file) {
      throw new Error('Missing "file" parameter');
    }

    const uri = await this.lsp.ensureFileOpen(file);
    const result = (await this.lsp.request('textDocument/documentSymbol', {
      textDocument: { uri },
    })) as Array<{
      name: string;
      kind: number;
      range: { start: { line: number } };
      children?: Array<{
        name: string;
        kind: number;
        range: { start: { line: number } };
      }>;
    }> | null;

    if (!result) {
      return { symbols: [] };
    }

    // Flatten (include children)
    const symbols: Array<{ name: string; kind: string; line: number }> = [];
    for (const sym of result) {
      symbols.push({
        name: sym.name,
        kind: SYMBOL_KIND_MAP[sym.kind] || 'unknown',
        line: sym.range.start.line + 1,
      });
      if (sym.children) {
        for (const child of sym.children) {
          symbols.push({
            name: child.name,
            kind: SYMBOL_KIND_MAP[child.kind] || 'unknown',
            line: child.range.start.line + 1,
          });
        }
      }
    }

    return { symbols };
  }

  // --- Helpers ---

  private mapLocations(
    locations: Array<{
      uri: string;
      range: { start: { line: number; character: number } };
    }>,
  ): Array<{ file: string; line: number; column: number }> {
    return locations.map((loc) => ({
      file: this.lsp.uriToPath(loc.uri),
      line: loc.range.start.line + 1,
      column: loc.range.start.character + 1,
    }));
  }

  private waitForDiagnostics(
    file: string,
    maxWaitMs: number,
    settleMs: number,
  ): Promise<DiagnosticItem[]> {
    return new Promise((resolve) => {
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      let maxTimer: ReturnType<typeof setTimeout>;

      const finish = () => {
        if (settleTimer) {
          clearTimeout(settleTimer);
        }
        clearTimeout(maxTimer);
        unsub();
        resolve(this.diagnosticsCache.get(file) || []);
      };

      // Listen for diagnostics updates for this file
      const unsub = this.lsp.onNotification(
        'textDocument/publishDiagnostics',
        (params: unknown) => {
          const p = params as { uri: string };
          if (this.lsp.uriToPath(p.uri) === file) {
            // Reset settle timer on each update
            if (settleTimer) {
              clearTimeout(settleTimer);
            }
            settleTimer = setTimeout(finish, settleMs);
          }
        },
      );

      // Max wait timeout
      maxTimer = setTimeout(finish, maxWaitMs);

      // If we already have cached diagnostics and the file was already open,
      // start the settle timer immediately (diagnostics may have already arrived)
      if (this.diagnosticsCache.has(file)) {
        settleTimer = setTimeout(finish, settleMs);
      }
    });
  }
}
