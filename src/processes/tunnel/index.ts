/**
 * Tunnel process — manages the dev tunnel child (`src/devTunnel/`, this
 * package's second bin).
 *
 * Handles startup config, stdout event parsing, and WS action handlers.
 * Uses requestId-based correlation for all stdin commands.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProcessManager } from '../ProcessManager.ts';
import { getAgentActivity } from '../agent/activity.ts';
import { parseJsonEvent } from '../parseJsonEvent.ts';
import { createLogger } from '../../logger.ts';
// The tunnel owns the protocol it speaks; this side imports it rather than
// keeping a copy. A hand-written mirror used to live in ./events.ts, and the
// three fields it had wrong — `branch`, `platform-method-started.method`, and
// the browser state's nullability — are why it does not any more.
import type {
  BrowserStep,
  SandboxBrowserStateEvent,
  TunnelAction,
  TunnelCommandParams,
  TunnelCommandResult,
  TunnelEvent,
  TunnelMessage,
} from '../../devTunnel/protocol.ts';

const log = createLogger('tunnel');

/** Parse a stdout line as a tunnel message (system event or command response). */
const parseTunnelMessage = (line: string) =>
  parseJsonEvent<TunnelMessage>(line);

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

export interface TunnelSessionState {
  sessionId: string;
  releaseId: string;
  proxyPort: number | null;
  proxyUrl: string | null;
}

export interface SandboxBrowserState {
  state:
    | 'starting'
    | 'running'
    | 'crashed'
    | 'restarting'
    | 'degraded'
    | 'stopped'
    | 'unknown';
  pid: number | null;
  previewMode: 'desktop' | 'mobile' | null;
  viewport: string | null;
  executablePath: string | null;
  /** Timestamp of most recent `running` transition. */
  startedAt: number | null;
  /** Timestamp of most recent `crashed` transition. */
  lastCrashAt: number | null;
  lastCrashExitCode: number | null;
  lastCrashSignal: string | null;
  /** Cumulative within session; reset to 0 on every `running`. */
  consecutiveFailures: number;
  /** Total `running` transitions after the first. */
  restartCount: number;
  degradedReason: 'repeated-crashes' | 'no-executable' | null;
}

function initialSandboxBrowserState(): SandboxBrowserState {
  return {
    state: 'unknown',
    pid: null,
    previewMode: null,
    viewport: null,
    executablePath: null,
    startedAt: null,
    lastCrashAt: null,
    lastCrashExitCode: null,
    lastCrashSignal: null,
    consecutiveFailures: 0,
    restartCount: 0,
    degradedReason: null,
  };
}

let sandboxBrowserState: SandboxBrowserState = initialSandboxBrowserState();

export function getSandboxBrowserState(): SandboxBrowserState {
  return { ...sandboxBrowserState };
}

// ---------------------------------------------------------------------------
// Replay video export — one job at a time, tracked here so a reconnecting
// editor picks the result back up from the init frame.
// ---------------------------------------------------------------------------

export interface RecordingExportStatus {
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  /** Absent when the mp4 was written to a private store — `store`/`key` locate
   *  it in that case, and the caller signs a link for it. */
  url?: string;
  store?: string;
  key?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  error?: string;
  errorCode?: string;
}

let recordingExport: RecordingExportStatus | null = null;
let recordingExportExpiry: ReturnType<typeof setTimeout> | null = null;
// Keep a finished job long enough for an editor that reloaded mid-render to
// still see the result.
const RECORDING_EXPORT_RETENTION_MS = 10 * 60_000;
// Above the tunnel's own budget (6-minute replay cap plus ready/encode/upload
// margin) so the tunnel's error code, not a bare timeout, is what we report.
const RECORDING_EXPORT_TIMEOUT_MS = 600_000;

export function getRecordingExportStatus(): RecordingExportStatus | null {
  return recordingExport ? { ...recordingExport } : null;
}

function finishRecordingExport(next: RecordingExportStatus): void {
  recordingExport = next;
  if (recordingExportExpiry) {
    clearTimeout(recordingExportExpiry);
  }
  recordingExportExpiry = setTimeout(() => {
    if (recordingExport?.jobId === next.jobId) {
      recordingExport = null;
    }
  }, RECORDING_EXPORT_RETENTION_MS);
}

// The server's broadcast, captured at startup so the export handler can
// announce completion outside a stdout callback.
let broadcastFn: TunnelCallbacks['broadcast'] | null = null;

export interface RecordingExportRequest {
  /** The rrweb recording session, and the window of it to render. */
  recordingSessionId: string;
  startTs: number;
  endTs: number;
  /** Brand wallpaper + window styling, resolved by whoever is asking (the
   *  tunnel has no brand data). Opaque here; the tunnel validates its
   *  contents. */
  stage?: Record<string, unknown>;
  /** App store for the finished mp4, and its access. Defaulted tunnel-side. */
  store?: string;
  access?: 'public' | 'private';
}

/**
 * Render a replay window to an mp4 on the box. Shared by the editor's Export
 * button (over WS) and the agent's `remy-admin qa-recordings export` (over the
 * sidecar), which differ in exactly two ways.
 *
 * `requireIdleAgent` — the render shares Chrome and two cores with everything
 * else, so a *human* must not be able to start one in the middle of a turn.
 * That check is meaningless for the agent, which is busy by definition while
 * asking: when the agent is the caller it is blocked awaiting this render, so
 * the box is otherwise idle (its own model call is remote). The real mutual
 * exclusion is the tunnel's `exportGate` + `enqueueBrowserWork`, which applies
 * to both paths either way.
 *
 * `awaitResult` — the editor gets a jobId immediately and watches progress
 * events; the CLI blocks and wants the URL.
 */
export async function startRecordingExport(
  pm: ProcessManager,
  req: RecordingExportRequest,
  opts: { requireIdleAgent: boolean; awaitResult: boolean },
): Promise<{ jobId: string; export?: RecordingExportStatus }> {
  if (
    typeof req.recordingSessionId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(req.recordingSessionId)
  ) {
    throw new Error('Missing "recordingSessionId" (32 hex characters)');
  }
  if (!Number.isFinite(req.startTs) || !Number.isFinite(req.endTs)) {
    throw new Error('Missing "startTs"/"endTs" (epoch milliseconds)');
  }
  if (
    req.stage !== undefined &&
    (typeof req.stage !== 'object' ||
      req.stage === null ||
      JSON.stringify(req.stage).length > 8192)
  ) {
    throw new Error('Invalid "stage" parameter');
  }
  if (opts.requireIdleAgent && getAgentActivity().busy) {
    throw new Error(
      'Remy is working right now — wait for the current turn to finish before exporting.',
    );
  }
  if (recordingExport?.status === 'running') {
    throw new Error('A video export is already running.');
  }

  const jobId = randomBytes(16).toString('hex');
  const startedAt = Date.now();
  if (recordingExportExpiry) {
    clearTimeout(recordingExportExpiry);
    recordingExportExpiry = null;
  }
  recordingExport = { jobId, status: 'running', startedAt };
  log.info(`Replay export started: ${jobId}`);

  const run = sendCommand(
    pm,
    'export-recording',
    {
      jobId,
      recordingSessionId: req.recordingSessionId,
      startTs: req.startTs,
      endTs: req.endTs,
      ...(req.stage ? { stage: req.stage } : {}),
      ...(req.store ? { store: req.store } : {}),
      ...(req.access ? { access: req.access } : {}),
    },
    RECORDING_EXPORT_TIMEOUT_MS,
  ).then(
    (res) => {
      if (recordingExport?.jobId !== jobId) {
        return null;
      }
      const finishedAt = Date.now();
      if (res.success) {
        finishRecordingExport({
          jobId,
          status: 'completed',
          startedAt,
          finishedAt,
          ...(typeof res.url === 'string' ? { url: res.url } : {}),
          ...(typeof res.store === 'string' ? { store: res.store } : {}),
          ...(typeof res.key === 'string' ? { key: res.key } : {}),
          width: res.width as number,
          height: res.height as number,
          durationMs: res.durationMs as number,
        });
      } else {
        const errorCode =
          typeof res.errorCode === 'string' ? res.errorCode : undefined;
        finishRecordingExport({
          jobId,
          status: errorCode === 'CANCELLED' ? 'cancelled' : 'failed',
          startedAt,
          finishedAt,
          error: typeof res.error === 'string' ? res.error : 'Export failed',
          ...(errorCode ? { errorCode } : {}),
        });
      }
      return announceRecordingExport(jobId);
    },
    // A rejection is the command itself failing to answer — a tunnel restart,
    // or the timeout above. Without this the job stayed 'running' forever and
    // every later export was refused as "already running", since a running job
    // sets no retention timer.
    (err: unknown) => {
      if (recordingExport?.jobId !== jobId) {
        return null;
      }
      finishRecordingExport({
        jobId,
        status: 'failed',
        startedAt,
        finishedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      });
      return announceRecordingExport(jobId);
    },
  );

  if (!opts.awaitResult) {
    void run;
    return { jobId };
  }
  const finished = await run;
  return { jobId, ...(finished ? { export: finished } : {}) };
}

function announceRecordingExport(jobId: string): RecordingExportStatus | null {
  const status = getRecordingExportStatus();
  log.info(`Replay export finished: ${jobId} (${status?.status})`);
  broadcastFn?.('recordingExportCompleted', { export: status });
  return status;
}

export interface TunnelCallbacks {
  onSessionStarted: (session: TunnelSessionState) => void;
  onSessionEnded: () => void;
  /** Called whenever the sandbox-browser PID should be added/removed from resource monitoring. */
  onSandboxBrowserPid: (pid: number | null) => void;
  broadcast: (event: string, data: Record<string, any>) => void;
}

/**
 * The tunnel's built entry, resolved relative to THIS module rather than looked
 * up on PATH.
 *
 * That is deliberate and load-bearing. The tunnel ships as a second bin of this
 * same package (`remy-tunnel`), so PATH would find it — but `CNC_DEV_BRANCH`
 * builds this server from a branch into /tmp and runs it from there, while
 * /usr/local/bin/remy-tunnel is still the copy baked into the image. A PATH
 * lookup would pair a branch C&C with a released tunnel and quietly test a
 * combination nobody asked about. Resolving off `import.meta.url` means one
 * branch name gets a matched pair, which the old two-package arrangement could
 * not guarantee.
 *
 * `'../../devTunnel/cli.js'` is a RUNTIME PATH, not an import specifier: it
 * names the emitted file, and must keep the `.js` even though every *import* in
 * this repo now names its `.ts` source. It also means `npm run dev` (tsx) needs
 * a `npm run build` first — see the check below.
 */
const TUNNEL_ENTRY = fileURLToPath(
  new URL('../../devTunnel/cli.js', import.meta.url),
);

export function startTunnel(
  pm: ProcessManager,
  config: {
    workspaceDir: string;
    devPort: number;
    apiKey: string;
    apiBaseUrl: string;
    userId: string;
  },
  callbacks: TunnelCallbacks,
): void {
  broadcastFn = callbacks.broadcast;

  if (!existsSync(TUNNEL_ENTRY)) {
    // Almost always `npm run dev` without a prior build: tsx compiles THIS file
    // on the fly, so import.meta.url points into src/ where only cli.ts exists.
    // tsx's loader rides process.execArgv and is not inherited by a child
    // spawned as `node <script>`, so pointing at the .ts would not help.
    throw new Error(
      `Dev tunnel entry not found at ${TUNNEL_ENTRY}. ` +
        'Run `npm run build` once before `npm run dev` — the tunnel child is ' +
        'spawned from dist/.',
    );
  }

  pm.start({
    name: 'tunnel',
    command: process.execPath,
    args: [
      TUNNEL_ENTRY,
      '--port',
      String(config.devPort),
      // Opt in to sandbox-hosted headless Chrome. Tunnel supervises it,
      // prefers it over user-connected browsers for automation commands,
      // and falls through to the user-browser path if Chrome isn't
      // available in the container.
      '--sandbox-browser',
      '--log-level',
      'info',
    ],
    // Credentials go on the environment, NOT argv. ProcessManager logs the full
    // command line, stores it as ProcessInfo.command, and serves that to the
    // editor in the process list — so an `--api-key` flag is a broadcast
    // channel. The tunnel reads these in devTunnel/config.ts.
    //
    // DB_WS_URL is deliberately absent: the container already sets it when the
    // platform has one, we inherit it, and the child inherits it from us.
    // Naming it here with a fallback is how a box ends up pointing its database
    // calls somewhere its auth token is not valid for.
    env: {
      MINDSTUDIO_API_KEY: config.apiKey,
      MINDSTUDIO_BASE_URL: config.apiBaseUrl,
      USER_ID: config.userId,
    },
    cwd: config.workspaceDir,
    stdin: true,
    restartOnCrash: true,
    maxRestarts: 5,
    critical: true,
    logStdout: false, // stdout is NDJSON protocol traffic, not useful in log file
    onStdout: (line) => handleStdout(line, callbacks),
  });
}

// ---------------------------------------------------------------------------
// requestId-based command correlation
// ---------------------------------------------------------------------------

let requestCounter = 0;
const pending = new Map<
  string,
  {
    resolve: (response: TunnelCommandResult[TunnelAction]) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Send a command to the tunnel and wait for the correlated response.
 *
 * Generic over the action, so the params and the resolved result are both the
 * ones that action actually declares (`devTunnel/protocol.ts`). Every call site
 * passes a literal action and none forwards one supplied by a client, so this
 * is checked end to end rather than being a type that looks reassuring.
 *
 * The two local failure shapes below — a dead tunnel and a timeout — are
 * `CommandFailure`, which is a member of every action's result union, so they
 * need no cast.
 */
export function sendCommand<A extends TunnelAction>(
  pm: ProcessManager,
  action: A,
  params?: TunnelCommandParams[A],
  timeoutMs = 30_000,
): Promise<TunnelCommandResult[A]> {
  // `CommandFailure` is a member of every action's result union, but TS cannot
  // prove that of an indexed access on an unresolved `A`, so the two local
  // failures below need this. One helper rather than two inline casts, so the
  // reason is stated once.
  const failure = (error: string): TunnelCommandResult[A] =>
    ({ success: false, error }) as TunnelCommandResult[A];

  if (pm.getState('tunnel') !== 'running') {
    return Promise.resolve(failure('tunnel not running'));
  }
  const requestId = `tc-${++requestCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(failure(`timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    pending.set(requestId, {
      // The pending map is keyed by requestId across every action, so it cannot
      // be typed per-action. The response we hand back IS this action's result:
      // the requestId that carries it was minted for this call.
      resolve: resolve as (r: TunnelCommandResult[TunnelAction]) => void,
      timer,
    });
    pm.writeStdin('tunnel', JSON.stringify({ requestId, action, ...params }));
  });
}

/**
 * Resolve every in-flight command as failed. Called when the tunnel process
 * leaves `running`: nothing will ever answer those requestIds, and without
 * this a caller waits out its full timeout (a replay export: ten minutes).
 */
export function failPendingCommands(reason: string): void {
  for (const [requestId, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve({ success: false, error: reason });
  }
}

// ---------------------------------------------------------------------------
// Stdout handling
// ---------------------------------------------------------------------------

function handleStdout(line: string, cb: TunnelCallbacks): void {
  const msg = parseTunnelMessage(line);
  if (!msg) {
    return;
  }

  // Command response — resolve pending promise, don't broadcast
  if ('requestId' in msg && msg.requestId) {
    const entry = pending.get(msg.requestId as string);
    if (entry) {
      // Skip intermediate "started" acks — wait for the final result
      if ((msg as Record<string, unknown>).status === 'started') {
        log.debug(
          `Intermediate ack for requestId=${msg.requestId}, waiting for final result`,
          { requestId: msg.requestId as string },
        );
        return;
      }
      pending.delete(msg.requestId as string);
      clearTimeout(entry.timer);
      // The framing (`event`/`requestId`/`status`) is stripped by the cast:
      // callers get the result the action declared, and the correlation fields
      // were only ever for routing it here.
      entry.resolve(msg as TunnelCommandResult[TunnelAction]);
    } else {
      log.debug(`No pending resolver for requestId=${msg.requestId}`, {
        requestId: msg.requestId as string,
      });
    }
    return;
  }

  // System event — broadcast to frontend + handle
  const tunnelEvent = msg as TunnelEvent;
  log.debug('Tunnel event', { event: tunnelEvent.event });
  cb.broadcast('tunnelEvent', { tunnelEvent });

  switch (tunnelEvent.event) {
    case 'recording-export-progress':
      cb.broadcast('recordingExportProgress', {
        jobId: tunnelEvent.jobId,
        phase: tunnelEvent.phase,
        percent: tunnelEvent.percent,
      });
      break;
    case 'session-starting':
      log.info('Session starting', {
        appId: tunnelEvent.appId,
        name: tunnelEvent.name,
      });
      break;
    case 'session-started': {
      const { sessionId, releaseId, proxyPort, proxyUrl } = tunnelEvent;
      log.info('Session started', { proxyPort, sessionId });
      cb.onSessionStarted({ sessionId, releaseId, proxyPort, proxyUrl });
      break;
    }
    case 'session-stopping':
      log.info('Session stopping');
      cb.onSessionEnded();
      break;
    case 'session-stopped':
      log.info('Session stopped');
      cb.onSessionEnded();
      break;
    case 'session-expired':
      log.error('Session expired by platform');
      cb.onSessionEnded();
      break;
    case 'platform-method-started':
      log.debug('Platform method started', {
        method: tunnelEvent.method,
        id: tunnelEvent.id,
      });
      break;
    case 'platform-method-completed':
      if (tunnelEvent.success) {
        log.debug('Platform method completed', {
          id: tunnelEvent.id,
          duration: tunnelEvent.duration,
        });
      } else {
        log.warn('Platform method failed', {
          id: tunnelEvent.id,
          error: tunnelEvent.error ?? 'unknown error',
        });
      }
      break;
    case 'schema-sync-started':
      log.info('Schema sync started');
      break;
    case 'schema-sync-completed':
      log.info('Schema sync completed', {
        created: tunnelEvent.created.length,
        altered: tunnelEvent.altered.length,
        errors: tunnelEvent.errors.length,
      });
      break;
    case 'connection-lost':
      log.warn('Connection lost', { message: tunnelEvent.message });
      break;
    case 'connection-restored':
      log.info('Connection restored');
      break;
    case 'config-changed':
      log.info('Config changed — session restarting', {
        path: tunnelEvent.path,
      });
      break;
    case 'config-error':
      log.warn('Config error', { message: tunnelEvent.message });
      break;
    // The tunnel booted, or restarted, without a usable mindstudio.json and is
    // retrying on a timer. Worth a log line: a degraded tunnel used to reach
    // the editor only through the generic `tunnelEvent` broadcast, so the C&C's
    // own log said nothing at all about why no session ever appeared.
    case 'degraded-state':
      log.warn('Tunnel degraded', { reason: tunnelEvent.reason });
      break;
    case 'degraded-state-resolved':
      log.info('Tunnel recovered from degraded state', {
        appId: tunnelEvent.appId,
      });
      break;
    case 'sandbox-browser-state':
      handleSandboxBrowserState(tunnelEvent, cb);
      break;
  }
}

/**
 * Apply a sandbox-browser-state transition to module state, notify the
 * ResourceMonitor about PID add/remove, and broadcast the new state so
 * the frontend can render Chrome's lifecycle without polling.
 */
function handleSandboxBrowserState(
  event: Extract<TunnelEvent, { event: 'sandbox-browser-state' }>,
  cb: TunnelCallbacks,
): void {
  const prev = sandboxBrowserState;
  const next: SandboxBrowserState = { ...prev };

  switch (event.state) {
    case 'starting':
      next.state = 'starting';
      if (event.previewMode !== undefined) {
        next.previewMode = event.previewMode ?? null;
      }
      break;
    case 'running':
      next.state = 'running';
      next.pid = event.pid;
      next.previewMode = event.previewMode ?? null;
      next.viewport = event.viewport;
      next.executablePath = event.executablePath;
      next.startedAt = Date.now();
      next.consecutiveFailures = 0;
      next.degradedReason = null;
      // Count subsequent `running` transitions as restarts (the very first
      // one is the initial launch).
      if (prev.state !== 'unknown' && prev.state !== 'starting') {
        next.restartCount = prev.restartCount + 1;
      } else if (prev.startedAt !== null) {
        next.restartCount = prev.restartCount + 1;
      }
      cb.onSandboxBrowserPid(event.pid);
      break;
    case 'crashed':
      next.state = 'crashed';
      next.pid = null;
      next.lastCrashAt = Date.now();
      next.lastCrashExitCode = event.exitCode;
      next.lastCrashSignal = event.signal;
      next.consecutiveFailures = event.consecutiveFailures;
      cb.onSandboxBrowserPid(null);
      log.warn('Sandbox Chrome crashed', {
        exitCode: event.exitCode,
        signal: event.signal,
        consecutiveFailures: event.consecutiveFailures,
      });
      break;
    case 'restarting':
      next.state = 'restarting';
      break;
    case 'degraded':
      next.state = 'degraded';
      next.pid = null;
      next.degradedReason = event.reason;
      // Narrowed on `reason`, not on `typeof event.consecutiveFailures`: only
      // the repeated-crashes variant carries a count, and saying so through the
      // discriminant means the compiler proves the field is there instead of
      // the code testing whether it turned up.
      if (event.reason === 'repeated-crashes') {
        next.consecutiveFailures = event.consecutiveFailures;
      }
      cb.onSandboxBrowserPid(null);
      log.error('Sandbox Chrome degraded — automation disabled for session', {
        reason: event.reason,
      });
      break;
    case 'stopped':
      // Full reset — counters are per-session, not per-sandbox-lifetime.
      Object.assign(next, initialSandboxBrowserState(), { state: 'stopped' });
      cb.onSandboxBrowserPid(null);
      break;
  }

  sandboxBrowserState = next;
  cb.broadcast('sandboxBrowserStateChanged', { sandboxBrowser: next });
}

// ---------------------------------------------------------------------------
// WS action handlers
// ---------------------------------------------------------------------------

/** Create WS action handlers for tunnel commands. */
export function createTunnelActions(
  pm: ProcessManager,
): Record<string, ActionHandler> {
  return {
    tunnelRunScenario: async (p) => {
      const { scenarioId, skipTruncate } = p as {
        scenarioId: string;
        skipTruncate?: boolean;
      };
      if (!scenarioId) {
        throw new Error('Missing "scenarioId" parameter');
      }
      log.info(`Running scenario: ${scenarioId}`);
      // Matches the agent-tool path's bound — seeds routinely outlive 30s,
      // and a shorter timeout reports failure while the tunnel finishes the
      // run (and its role assignment) anyway.
      return await sendCommand(
        pm,
        'run-scenario',
        { scenarioId, ...(skipTruncate ? { skipTruncate } : {}) },
        300_000,
      );
    },
    tunnelRunMethod: async (p) => {
      const { method, input, roles, userId } = p as {
        method: string;
        input?: Record<string, unknown>;
        roles?: string[];
        userId?: string;
      };
      if (!method) {
        throw new Error('Missing "method" parameter');
      }
      log.info(`Running method: ${method}`);
      return await sendCommand(
        pm,
        'run-method',
        {
          method,
          input: input ?? {},
          ...(roles ? { roles } : {}),
          ...(userId ? { userId } : {}),
        },
        30_000,
      );
    },
    tunnelBrowser: async (p) => {
      // The editor supplies these over WS, so they are unknown until checked.
      // `BrowserStep` keeps an index signature for exactly this: the tunnel
      // validates each step's `command` itself, and this side must not have to
      // grow a case per browser verb to pass one through.
      const { steps } = p as { steps?: BrowserStep[] };
      if (!steps) {
        throw new Error('Missing "steps" parameter');
      }
      return await sendCommand(pm, 'browser', { steps }, 120_000);
    },
    tunnelScreenshot: async (p) => {
      const { path } = p as { path?: string };
      return await sendCommand(
        pm,
        'screenshotFullPage',
        path ? { path } : {},
        120_000,
      );
    },
    // Set the dev test user's roles — a real write to the user's row via the
    // platform (upsert + role update + users-table sync), hence a timeout
    // sized for a platform round-trip.
    tunnelSetTestUserRoles: async (p) => {
      const { roles } = p as { roles: string[] };
      if (!Array.isArray(roles)) {
        throw new Error('Missing "roles" parameter (array of role IDs)');
      }
      log.info(`Setting test user roles: ${roles.join(', ') || '(none)'}`);
      return await sendCommand(pm, 'set-test-user-roles', { roles }, 15_000);
    },
    // Find-or-create the dev test user and return it with its current roles.
    tunnelGetTestUser: async () => {
      return await sendCommand(pm, 'get-test-user', {}, 15_000);
    },
    listDatabases: async () => {
      return await sendCommand(pm, 'list-databases', {}, 30_000);
    },
    // Render a browser-test replay to an mp4 on the box. Answers at once with
    // a jobId — the editor's request has no timeout, so the render is never
    // awaited here. Progress arrives as `recordingExportProgress`, the result
    // as `recordingExportCompleted`, and the init frame carries the status.
    tunnelExportRecording: async (p) => {
      const { jobId } = await startRecordingExport(
        pm,
        p as unknown as RecordingExportRequest,
        // A human clicked Export: refuse mid-turn, and answer with the jobId
        // rather than holding the request open for the whole render.
        { requireIdleAgent: true, awaitResult: false },
      );
      return { jobId };
    },
    tunnelCancelExportRecording: async (p) => {
      const { jobId } = p as { jobId?: string };
      if (typeof jobId !== 'string' || !jobId) {
        throw new Error('Missing "jobId" parameter');
      }
      return await sendCommand(
        pm,
        'cancel-export-recording',
        { jobId },
        15_000,
      );
    },
  };
}
