/**
 * Tunnel process — spawns the dev tunnel child (`src/devTunnel/`, this
 * package's second bin) and speaks its stdin/stdout protocol.
 *
 * This file is the process and the wire: spawn, requestId-correlated commands,
 * and the stdout event loop. The rest of the directory is what rides on it —
 * `actions.ts` (the editor's WS actions), `recording.ts` (replay export),
 * `browserState.ts` (the sandbox Chrome's lifecycle), `notify.ts` (the
 * workspace watcher's notifications) — the same split `../agent/` has.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ProcessManager } from '../ProcessManager.ts';
import { parseJsonEvent } from '../parseJsonEvent.ts';
import { createLogger } from '../../logger.ts';
// The tunnel owns the protocol it speaks; this side imports it rather than
// keeping a copy. A hand-written mirror used to live in ./events.ts, and the
// three fields it had wrong — `branch`, `platform-method-started.method`, and
// the browser state's nullability — are why it does not any more.
import type {
  TunnelAction,
  TunnelCommandParams,
  TunnelCommandResult,
  TunnelEvent,
  TunnelMessage,
} from '../../devTunnel/protocol.ts';
import { handleSandboxBrowserState } from './browserState.ts';
import { setRecordingExportBroadcast } from './recording.ts';

const log = createLogger('tunnel');

/** Parse a stdout line as a tunnel message (system event or command response). */
const parseTunnelMessage = (line: string) =>
  parseJsonEvent<TunnelMessage>(line);

export interface TunnelSessionState {
  sessionId: string;
  releaseId: string;
  proxyPort: number | null;
  proxyUrl: string | null;
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
  workspaceDir: string,
  callbacks: TunnelCallbacks,
): void {
  setRecordingExportBroadcast(callbacks.broadcast);

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
    // No flags, and no `env`. Everything this used to pass was either constant
    // or a value the tunnel reads better itself — the dev port, from web.json on
    // every session start. Credentials and the base URL come from the container
    // environment, which the child inherits along with everything else in it
    // (`devTunnel/config.ts` names what it needs); re-injecting the same values
    // under the same names bought nothing. Never on argv: ProcessManager logs
    // the full command line and serves it to the editor's process list.
    //
    // `DB_WS_URL` in particular must stay inherited rather than named here with
    // a fallback — that is how a box ends up pointing its database calls
    // somewhere its auth token is not valid for. See `getDbWsUrl`.
    args: [TUNNEL_ENTRY],
    cwd: workspaceDir,
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
    // Not `Promise.resolve(...)`: its `Awaited<>` return type distributes over
    // every action's result union, which is now large enough that TS refuses to
    // represent it (TS2590). The executor form below checks against the
    // declared type directly.
    return new Promise((resolve) => resolve(failure('tunnel not running')));
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
