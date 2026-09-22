/**
 * Session recorder — one long-lived rrweb recording per document lifetime.
 *
 * Unlike a per-command recording, this keeps a single record() instance alive
 * across browser commands so the rrweb node-ID namespace stays continuous: the
 * first flush carries the Meta + FullSnapshot, every later flush carries
 * incremental events only. Callers concatenate the flushes in order and play
 * them back as one seamless recording — no per-command FullSnapshot, so no DOM
 * teardown/rebuild (and no flash) at command boundaries.
 *
 * The recorder starts lazily on the first interactive command and dies with
 * the document. A hard navigation destroys window.__ms, so the next document
 * starts a fresh run (new runId + new FullSnapshot) — a legitimate rebuild
 * seam that maps to a real page load.
 *
 * Besides the DOM, the stream carries rrweb custom events as explicit action
 * markers for the editor's replay stitcher: `ms-step` at each executed step and
 * `ms-navigation` at each route change. The stitcher compresses everything not
 * near a marker into a short beat, and used to infer markers from cursor
 * motion alone — which a tunnel-side soft `navigate` (pushState, no cursor)
 * never produced, so page changes flashed past.
 *
 * Modeled on the continuous mirror recorder (src/mirror/record.ts).
 */

import { record } from 'rrweb';
import { getState } from '../state';

function genRunId(): string {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // crypto.randomUUID throws in non-secure contexts — fall through.
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Start the session recorder if it isn't already running. Idempotent.
 *
 * rrweb captures the anchor FullSnapshot synchronously inside record(), so
 * call this before the interactive step whose result carries the first flush.
 * No checkoutEveryNms — periodic FullSnapshots would reintroduce mid-stream
 * rebuilds, which is exactly what continuous recording removes.
 */
export function ensureSessionRecorder(): void {
  const s = getState().sessionRecording;
  if (s.active) {
    return;
  }

  try {
    const stop = record({
      emit: (e) => s.buffer.push(e),
      collectFonts: true,
      // Our in-DOM cursor + click ripple are already captured as mutations,
      // so suppress rrweb's native indicators to avoid a duplicate cursor/
      // click dot on playback (carried over from the old per-batch config).
      sampling: {
        mousemove: false,
        mouseInteraction: false,
      },
    });
    if (stop) {
      s.active = true;
      s.runId = genRunId();
      s.stopFn = stop;
    }
  } catch {
    // rrweb init failure is non-fatal — just skip recording.
  }
}

/**
 * Drain everything buffered since the last flush, tagged with the run it
 * belongs to. Returns null if the recorder never started or nothing new
 * accumulated.
 */
export function flushSessionRecording(): {
  events: unknown[];
  runId: string;
} | null {
  const s = getState().sessionRecording;
  if (!s.active || !s.runId || s.buffer.length === 0) {
    return null;
  }
  const events = s.buffer.splice(0);
  return { events, runId: s.runId };
}

/** The current run's id, or null if the recorder hasn't started. */
export function getRunId(): string | null {
  return getState().sessionRecording.runId;
}

/** Whether the continuous session recorder is currently running. */
export function isRecording(): boolean {
  return getState().sessionRecording.active;
}

/** Mark the start of an executed step (see the header). */
export function markStep(command: string, index: number): void {
  emitMarker('ms-step', { command, index });
}

/** Mark a route change (see the header). */
export function markNavigation(url: string): void {
  emitMarker('ms-navigation', { url });
}

function emitMarker(tag: string, payload: Record<string, unknown>): void {
  if (!getState().sessionRecording.active) {
    return;
  }
  try {
    record.addCustomEvent(tag, payload);
  } catch {
    // Recorder torn down between the check and the emit — nothing to mark.
  }
}
