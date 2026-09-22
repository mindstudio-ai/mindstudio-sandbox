/**
 * Replay video export — one job at a time, tracked here so a reconnecting
 * editor picks the result back up from the init frame.
 */

import { randomBytes } from 'node:crypto';
import type { ProcessManager } from '../ProcessManager.ts';
import { getAgentActivity } from '../agent/activity.ts';
import { createLogger } from '../../logger.ts';
import { sendCommand, type TunnelCallbacks } from './index.ts';

const log = createLogger('tunnel');

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

let recordingExport: RecordingExportStatus | null = null;
let recordingExportExpiry: ReturnType<typeof setTimeout> | null = null;
// Keep a finished job long enough for an editor that reloaded mid-render to
// still see the result.
const RECORDING_EXPORT_RETENTION_MS = 10 * 60_000;
// Above the tunnel's own budget (6-minute replay cap plus ready/encode/upload
// margin) so the tunnel's error code, not a bare timeout, is what we report.
const RECORDING_EXPORT_TIMEOUT_MS = 600_000;

// The server's broadcast, captured when the tunnel starts so the export
// handler can announce completion outside a stdout callback.
let broadcastFn: TunnelCallbacks['broadcast'] | null = null;

export function setRecordingExportBroadcast(
  broadcast: TunnelCallbacks['broadcast'],
): void {
  broadcastFn = broadcast;
}

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

function announceRecordingExport(jobId: string): RecordingExportStatus | null {
  const status = getRecordingExportStatus();
  log.info(`Replay export finished: ${jobId} (${status?.status})`);
  broadcastFn?.('recordingExportCompleted', { export: status });
  return status;
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
