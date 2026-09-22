/**
 * The wire contract between the in-page browser agent and the tunnel's proxy —
 * everything that crosses `/__mindstudio_dev__/ws`, plus the step and result
 * shapes that ride inside it.
 *
 * IMPORT-FREE ON PURPOSE. This file is compiled by both TypeScript programs in
 * this package: the browser one (`tsconfig.browser.json`, bundler resolution,
 * `types: []`) reaches it from `commands/ws-client.ts`, and the root Node one
 * (NodeNext resolution) reaches it from `devTunnel/proxy/proxy.ts` — the root
 * program excludes this directory from its glob but still follows imports into
 * it. A file with no imports is legal under either resolution mode, which is
 * the whole trick; `devTunnel/protocol.ts` is the same trick for the
 * tunnel↔C&C channel. Until this existed the two ends parsed each other's
 * messages as `Record<string, unknown>`, and nothing checked that what went on
 * the wire matched what the other side believed it would read.
 *
 * Not covered: the mirror-viewer and replay-render pages the proxy serves as
 * inline scripts (`proxy.ts`). Those are strings, and speak `hello`/`mirror` by
 * hand.
 *
 * @module
 */

// -- Viewport ---------------------------------------------------------------

/** The two viewports the sandbox Chrome and the editor's preview know. */
export type PreviewMode = 'desktop' | 'mobile';

// -- Steps and results ------------------------------------------------------

/**
 * A single browser-automation step inside a `browser` batch.
 *
 * Open by design (the index signature): the page's executor owns the verb
 * table and validates each step, while the tunnel and the C&C relay batches
 * they do not interpret — from the editor over WS and from the agent as a tool
 * call. Adding a browser verb must not require a change on any relay.
 */
export interface BrowserStep {
  command: string;
  path?: string;
  scrollToSelector?: string;
  scrollY?: number;
  width?: number;
  height?: number;
  url?: string;
  fresh?: boolean;
  /**
   * `setViewport` only, and wider than `PreviewMode`: `'default'` means "the
   * app's configured defaultPreviewMode, falling back to desktop", which is
   * what remy's per-run reset sends. Absent behaves the same as `'default'`.
   * Typed narrower than this at first, and the set-viewport call site in
   * `lsp/sidecar.ts` is what caught it.
   */
  mode?: PreviewMode | 'default';
  format?: 'png' | 'jpeg';
  [key: string]: unknown;
}

export interface StepResult {
  index: number;
  command: string;
  result?: unknown;
  matched?: string;
  elapsed?: number;
  error?: string;
}

/**
 * A browser-side log entry: console output, an error, a network request, a
 * click. Open shape — the page's capture modules each add their own fields,
 * and the tunnel only infers a level from `type`/`level` before writing it.
 */
export interface LogEntry {
  type: string;
  [key: string]: unknown;
}

export interface CommandResult {
  id: string;
  steps: StepResult[];
  snapshot: string;
  logs: LogEntry[];
  duration: number;
  /** Set when the batch was refused as a whole — the agent was already busy. */
  error?: string;
  /** A flush of the continuous session recording — the rrweb events buffered
   *  since the last command. The first flush of a run carries the Meta +
   *  FullSnapshot; later flushes are incremental-only and share the same
   *  node-ID namespace, so the tunnel can concatenate them seamlessly. */
  events?: unknown[];
  /** Identifies the recorder run (document lifetime) these events belong to.
   *  A new runId means a fresh FullSnapshot — i.e. a real page load / rebuild
   *  seam. Stable across same-document commands and SPA navigations. */
  runId?: string;
}

// -- Mirror -----------------------------------------------------------------

/**
 * One rrweb event, as loosely as the proxy needs it: it peeks at `type` (2 =
 * FullSnapshot, 4 = Meta) and at Meta's `data.width`/`height`, and relays the
 * rest untouched. The full format is rrweb's, pinned in package.json.
 */
export interface MirrorEvent {
  type: number;
  timestamp?: number;
  data?: Record<string, unknown>;
}

/**
 * A batch of rrweb events. Sent by a mirror SOURCE (a phone that opened the app
 * with `?mirror=true`) and relayed by the proxy to every mirror VIEWER, so it
 * appears in both directions.
 */
export interface MirrorBatch {
  type: 'mirror';
  events: MirrorEvent[];
}

// -- Page → proxy -----------------------------------------------------------

/** First message on every connection; the proxy closes a socket that opens with anything else. */
export interface PageHello {
  type: 'hello';
  /** `mirror` is only ever sent by the proxy's inline viewer page. */
  mode: 'iframe' | 'standalone' | 'mirror';
  url: string;
  viewport: { w: number; h: number };
  /** This client is a mirror recording source. */
  mirror?: boolean;
  /** The sandbox-owned headless Chrome. The proxy believes this only from loopback. */
  sandbox?: boolean;
  /**
   * The command whose remaining steps this page is about to resume after a
   * navigation, from the stash. Explicit `null` means "checked, no stash" — the
   * proxy uses the distinction to fail commands whose in-flight steps died with
   * the previous page instead of waiting out a disconnect grace timer.
   */
  resumingCommandId?: string | null;
}

export type PageResult = { type: 'result' } & CommandResult;

export interface PageLog {
  type: 'log';
  entries: LogEntry[];
}

export type PageToProxyMessage = PageHello | PageResult | PageLog | MirrorBatch;

// -- Proxy → page -----------------------------------------------------------

export interface ProxyAck {
  type: 'ack';
  clientId: string;
}

export interface ProxyCommand {
  type: 'command';
  id: string;
  steps: BrowserStep[];
}

/** `reload`: clear the auth cookie and navigate to `/`. Sent on session restart. */
export interface ProxyBroadcast {
  type: 'broadcast';
  action: 'reload';
  payload?: Record<string, unknown>;
}

export type ProxyToPageMessage =
  | ProxyAck
  | ProxyCommand
  | ProxyBroadcast
  | MirrorBatch;
