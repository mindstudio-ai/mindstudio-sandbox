/**
 * The wire protocol between the dev tunnel and the C&C server.
 *
 * The two halves are separate processes in the same package: the C&C spawns the
 * tunnel and they speak newline-delimited JSON over its stdin/stdout. This
 * module is the single description of that conversation, and both sides import
 * it — the producer to be checked when it emits, the consumer to be checked
 * when it reads.
 *
 * Before this existed the producer emitted `Record<string, unknown>` and the
 * consumer kept a hand-written union in the other half of the repo. Nothing
 * compared them, and `parseJsonEvent` validates only that a line has a string
 * `event`. Three fields had quietly diverged: `session-started.branch` was
 * declared required and never sent, `platform-method-started.method` was
 * declared required but can be absent on the wire, and `sandbox-browser-state`
 * said `pid: number` while one of its two emit sites sends null.
 *
 * DELIBERATELY A LEAF: types and const arrays only, and no relative imports
 * but one — the page-agent protocol, itself a leaf. The consumer can read it
 * without dragging the tunnel's module graph into the C&C process, and it stays
 * valid whatever happens to either side's internals. Anything that needs a
 * value from elsewhere belongs in the module that owns that value, not here.
 *
 * @module
 */

// The page owns the step the C&C relays to it and the viewport it names. Both
// are re-exported so the C&C keeps one import for everything it sends here.
import type { BrowserStep, PreviewMode } from '../browserAgent/protocol.ts';
export type { BrowserStep, PreviewMode } from '../browserAgent/protocol.ts';

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export interface TunnelRole {
  id: string;
  name: string;
  description?: string;
}

export interface TunnelScenario {
  id: string;
  name: string;
  description?: string;
  path: string;
  roles: string[];
}

/**
 * Machine-readable failure codes. Any command can answer with one of these:
 * the router catches a thrown `CommandError` and turns it into a failure
 * response, so these are part of every action's result type.
 */
export const ERROR_CODES = [
  'NO_SESSION',
  'NO_BROWSER',
  'BROWSER_TIMEOUT',
  'BROWSER_DISCONNECTED',
  'COMMAND_LOST_ON_NAVIGATION',
  'PAGE_LEFT_APP_ORIGIN',
  'BROWSER_SEND_FAILED',
  'BROWSER_ERROR',
  'INVALID_INPUT',
  'EXECUTION_ERROR',
  'UNKNOWN_ACTION',
  'UPLOAD_FAILED',
  /** A replay export holds the browser; browser/screenshot commands fail fast. */
  'BUSY',
  /** ffmpeg is not installed on this sandbox (older image). */
  'FFMPEG_UNAVAILABLE',
  /** The replay render or encode failed. */
  'RENDER_FAILED',
  /** The export was cancelled by the caller. */
  'CANCELLED',
  'INFRASTRUCTURE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// System events — unsolicited, no requestId
// ---------------------------------------------------------------------------

/**
 * The sandbox-hosted browser's lifecycle, discriminated on `state`.
 *
 * Split out of `TunnelEvent` because it is the one event with sub-shapes — six
 * of them across nine emit sites in `browser/supervisor.ts` — and a nested
 * discriminant reads better than nine more `TunnelEvent` members.
 */
export type SandboxBrowserStateEvent =
  | { event: 'sandbox-browser-state'; state: 'stopped' }
  | {
      event: 'sandbox-browser-state';
      state: 'starting';
      attempt: number;
      previewMode: PreviewMode;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'running';
      /**
       * Null when Chrome is up but its process handle has no pid — puppeteer
       * can report that, and `applyPreviewMode` emits it as null rather than
       * inventing a number. The consumer's `onSandboxBrowserPid` treats null as
       * "stop tracking", which is the right answer.
       */
      pid: number | null;
      previewMode: PreviewMode;
      viewport: string;
      /**
       * Also nullable, and the compiler is what found it: the supervisor's own
       * field is `string | null` (it is set in `launchOnce`), and
       * `applyPreviewMode` can emit before that has happened. In practice the
       * launch sets it first, which is why nobody noticed — but "in practice"
       * is not a type.
       */
      executablePath: string | null;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'crashed';
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      consecutiveFailures: number;
      /** Present when the launch itself threw; absent on a disconnect. */
      error?: string;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'restarting';
      delayMs: number;
      nextAttempt: number;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'degraded';
      reason: 'no-executable';
    }
  | {
      event: 'sandbox-browser-state';
      state: 'degraded';
      reason: 'repeated-crashes';
      consecutiveFailures: number;
    };

export type TunnelEvent =
  // -- Session lifecycle ----------------------------------------------------
  | { event: 'session-starting'; appId: string; name: string }
  | {
      event: 'session-started';
      sessionId: string;
      releaseId: string;
      proxyPort: number | null;
      proxyUrl: string | null;
      roles: TunnelRole[];
      scenarios: TunnelScenario[];
    }
  | { event: 'session-stopping' }
  | { event: 'session-stopped' }
  /**
   * The platform rejected our credential. Terminal: the key comes from our
   * environment, so there is nothing to retry. The tunnel exits 0 after this
   * so the C&C does not treat it as a crash — see `ipc/session-events.ts`.
   */
  | { event: 'session-expired' }

  // -- Degraded operation ---------------------------------------------------
  /** Booted (or restarted) without a usable `mindstudio.json`; retrying. */
  | { event: 'degraded-state'; reason: string }
  | { event: 'degraded-state-resolved'; appId?: string }

  // -- Platform method execution -------------------------------------------
  /**
   * `method` is optional because it genuinely can be: the runner passes the
   * poll queue's `method`, which is itself optional, and `JSON.stringify` drops
   * undefined keys rather than sending null.
   */
  | { event: 'platform-method-started'; id: string; method?: string }
  | {
      event: 'platform-method-completed';
      id: string;
      success: boolean;
      duration: number;
      error?: string;
    }

  // -- Schema sync ----------------------------------------------------------
  | { event: 'schema-sync-started' }
  | {
      event: 'schema-sync-completed';
      created: string[];
      altered: string[];
      errors: string[];
    }

  // -- Connection health ----------------------------------------------------
  | { event: 'connection-lost'; message: string }
  | { event: 'connection-restored' }

  // -- Config ---------------------------------------------------------------
  | { event: 'config-changed'; path: string }
  | { event: 'config-error'; message: string }

  // -- Sandbox browser -----------------------------------------------------
  | SandboxBrowserStateEvent

  // -- Replay export progress ----------------------------------------------
  | {
      event: 'recording-export-progress';
      jobId: string;
      phase: 'loading' | 'rendering' | 'encoding' | 'uploading';
      percent: number;
    };

/** The `event` string of every system event. */
export type TunnelEventName = TunnelEvent['event'];

// ---------------------------------------------------------------------------
// Commands — stdin in, correlated response out
// ---------------------------------------------------------------------------

/**
 * Every command can fail this way: the router catches whatever a handler throws
 * and answers with this shape, so it is part of every result union rather than
 * something individual handlers opt into.
 */
export interface CommandFailure {
  success: false;
  error: string;
  errorCode?: ErrorCode;
}

/** Where an uploaded rrweb chunk landed, attached to a recorded batch. */
export interface RecordingChunkRef {
  path: string;
  sessionId: string;
  runId: string;
  seq: number;
  containsSnapshot: boolean;
  startTs: number;
  endTs: number;
  width: number;
  height: number;
}

/** Params per action. `{}` means the action takes nothing but a requestId. */
export interface TunnelCommandParams {
  'run-method': {
    method: string;
    input?: unknown;
    roles?: string[];
    userId?: string;
  };
  'test-jewel': { method: string; humanInput?: unknown; subject?: unknown };
  'test-mapper': {
    dataSource: string;
    objects?: unknown[];
    timeoutMs?: number;
  };
  'run-scenario': { scenarioId: string; skipTruncate?: boolean };
  'set-test-user-roles': { roles: string[] };
  'get-test-user': Record<string, never>;
  browser: { steps: BrowserStep[] };
  screenshotFullPage: { path?: string; format?: 'png' | 'jpeg' };
  screenshotViewport: {
    path?: string;
    scrollToSelector?: string;
    scrollY?: number;
    width?: number;
    height?: number;
    format?: 'png' | 'jpeg';
  };
  renderHtml: {
    html: string;
    width: number;
    height: number;
    scale?: number;
    autoHeight?: boolean;
    transparent?: boolean;
  };
  'db-query': { sql: string; databaseId?: string };
  'list-databases': Record<string, never>;
  'setup-browser': {
    auth?: { email?: string; phone?: string; roles?: string[] };
    path?: string;
  };
  'dev-server-restarting': Record<string, never>;
  'restart-worker': Record<string, never>;
  /**
   * The C&C's workspace watcher saw `mindstudio.json`, or an interface config it
   * references, change. `path` is absolute. The tunnel decides what that means
   * — hot-apply, a session restart, or "invalid, keeping the current session" —
   * and answers once it has; it used to watch these files itself.
   */
  'config-file-changed': { path: string };
  /** A declared table source file changed; re-sync the schema. */
  'table-file-changed': Record<string, never>;
  'export-recording': {
    jobId: string;
    recordingSessionId: string;
    startTs: number;
    endTs: number;
    stage?: Record<string, unknown>;
    store?: string;
    access?: 'public' | 'private';
  };
  'cancel-export-recording': { jobId: string };
}

export type TunnelAction = keyof TunnelCommandParams;

/**
 * Result per action.
 *
 * Two shapes appear here, and the difference is not stylistic — it is what the
 * handlers actually send, which is what this file is for.
 *
 * Some handlers genuinely discriminate: they return early on failure with
 * `success: false` and nothing else useful. Others — `run-method`,
 * `run-scenario`, `browser` — return ONE object whose `success` is a computed
 * boolean, with `error`/`errorCode` filled in beside the payload. That is right
 * for them: a method that threw still has captured stdout and a duration worth
 * reporting, and a browser batch can fail on step 3 of 5 and still owe the
 * caller the first two results. Forcing those into a union would have meant
 * changing the wire format, which this work deliberately does not do.
 *
 * On top of either, the router can always answer with `CommandFailure` alone:
 * it catches whatever a handler throws and reports that instead.
 */
export interface TunnelCommandResult {
  /** One shape: `success` is computed, and the diagnostics ride along with it. */
  'run-method':
    | {
        success: boolean;
        method: string;
        output: unknown;
        error: string | null;
        errorCode?: ErrorCode;
        /** The full error object from the method worker — stack, cause, code. */
        errorDetail: unknown;
        stdout: string[];
        duration: number;
      }
    | CommandFailure;
  'test-jewel':
    | {
        success: true;
        method: string;
        pair: unknown;
        stdout: string[];
        duration: number;
      }
    | (CommandFailure & { method?: string });
  'test-mapper':
    | {
        success: true;
        dataSource: string;
        record: unknown;
        stdout: string[];
        duration: number;
      }
    | (CommandFailure & { dataSource?: string });
  /** One shape, as `run-method`. */
  'run-scenario':
    | {
        success: boolean;
        scenarioId: string;
        /** Null when the scenario declares no name — the id is the fallback. */
        name: string | null;
        /** Roles the scenario assigned to the dev test user; absent on failure. */
        roles?: string[];
        error: string | null;
        errorCode?: ErrorCode;
      }
    | CommandFailure;
  'set-test-user-roles':
    | { success: true; user: unknown; roles: string[] }
    | CommandFailure;
  'get-test-user':
    | { success: true; user: unknown; roles: string[] }
    | CommandFailure;
  /**
   * One shape: a batch that fails partway still owes the caller the steps that
   * did run, plus whatever the recorder buffered.
   */
  browser:
    | {
        success: boolean;
        steps: unknown[];
        snapshot: string;
        logs: unknown[];
        duration: number;
        errorCode?: ErrorCode;
        recording?: RecordingChunkRef;
      }
    | CommandFailure;
  screenshotFullPage: ScreenshotResult;
  screenshotViewport: ScreenshotResult;
  renderHtml:
    | {
        success: true;
        /** See ScreenshotResult — same guarantee, from the same overload. */
        url: string;
        width: number;
        height: number;
        duration: number;
      }
    | CommandFailure;
  'db-query':
    | { success: true; databaseId: string; results: unknown }
    | CommandFailure;
  'list-databases': { success: true; databases: unknown[] } | CommandFailure;
  'setup-browser':
    | { success: true; path: string; authenticated: boolean }
    | CommandFailure;
  'dev-server-restarting': { success: true } | CommandFailure;
  'restart-worker': { success: true } | CommandFailure;
  'config-file-changed': { success: true } | CommandFailure;
  'table-file-changed': { success: true } | CommandFailure;
  'export-recording':
    | {
        success: true;
        jobId: string;
        /** Absent when the mp4 went to a private store — use `store`/`key`. */
        url?: string;
        store: string;
        key?: string;
        access: 'public' | 'private';
        width: number;
        height: number;
        durationMs: number;
        bytes: number;
        elapsedMs: number;
      }
    | (CommandFailure & { jobId?: string });
  'cancel-export-recording':
    | { success: true; cancelled: boolean }
    | CommandFailure;
}

/**
 * Shared by the two screenshot commands, which return the same thing.
 *
 * `url` was `string | undefined` here, described as a latent gap: the upload
 * grant declared `publicUrl?: string` and the handlers passed it through
 * unchecked, so a caller could be told a screenshot succeeded and given nowhere
 * to fetch it. It was latent in the literal sense — not reachable. The platform
 * omits `publicUrl` only for a private `store` target or the legacy storeless
 * private upload, both of which a caller has to opt into, and the screenshot
 * handlers never do. `getUploadUrl` is now overloaded so a targetless call
 * returns `publicUrl: string`, which makes that guarantee the compiler's rather
 * than a comment's, and lets this be a plain `string`.
 */
export type ScreenshotResult =
  | {
      success: true;
      url: string;
      width: number;
      height: number;
      styleMap?: unknown;
      duration: number;
    }
  | CommandFailure;

/**
 * The framing the router puts around every handler result. `started` carries a
 * partial acknowledgement (which command, on what) and no result; `completed`
 * carries the result spread into it.
 */
export type TunnelCommandResponse<A extends TunnelAction = TunnelAction> = {
  event: A;
  requestId: string;
} & (
  | { status: 'started'; [key: string]: unknown }
  | ({ status: 'completed' } & TunnelCommandResult[A])
);

/** Anything the tunnel writes to stdout. */
export type TunnelMessage = TunnelEvent | TunnelCommandResponse;
