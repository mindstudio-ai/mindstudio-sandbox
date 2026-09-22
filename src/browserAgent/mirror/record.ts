/**
 * Mirror recording — streams DOM state to the tunnel proxy via rrweb.
 *
 * Activated by ?mirror=true on the URL (set when user scans QR code).
 * The flag is stripped from the URL and persisted to sessionStorage so
 * it survives SPA and hard navigation.
 *
 * Events are batched and sent as `{ type: 'mirror' }` WS messages.
 * The proxy relays them to any connected mirror viewer.
 */

import { record } from 'rrweb';
import { getState } from '../state';
import { getSocket } from '../commands/ws-client';
import type { MirrorBatch, MirrorEvent } from '../protocol';

const BATCH_INTERVAL = 16; // ms — flush every frame for real-time feel
const CHECKOUT_INTERVAL = 30_000; // ms — full snapshot for late joiners / reconnect
const MIRROR_STORAGE_KEY = '__ms_mirror';

function shouldMirror(): boolean {
  // Check query param first — strip it from URL if found
  const params = new URLSearchParams(window.location.search);
  if (params.get('mirror') === 'true') {
    params.delete('mirror');
    const clean = params.toString();
    const newUrl =
      window.location.pathname +
      (clean ? '?' + clean : '') +
      window.location.hash;
    window.history.replaceState(null, '', newUrl);
    try {
      sessionStorage.setItem(MIRROR_STORAGE_KEY, '1');
    } catch {}
    return true;
  }
  // Fall back to sessionStorage (persists across navigation)
  try {
    return sessionStorage.getItem(MIRROR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export async function initMirrorRecording(): Promise<void> {
  if (window.parent !== window) {
    return;
  }
  if (!shouldMirror()) {
    return;
  }

  const s = getState().mirror;
  if (s.recording) {
    return;
  }

  let batch: MirrorEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    flushTimer = null;
    if (batch.length === 0) {
      return;
    }

    const sock = getSocket();
    if (!sock) {
      // WS not ready — keep events in batch, retry shortly
      flushTimer = setTimeout(flush, BATCH_INTERVAL);
      return;
    }

    const events = batch;
    batch = [];
    sock.send(JSON.stringify({ type: 'mirror', events } satisfies MirrorBatch));
  }

  function emit(event: MirrorEvent) {
    batch.push(event);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  }

  // Wait for the page to settle before taking the first snapshot.
  // document.readyState 'complete' means all resources loaded, then
  // a short extra delay for React/framework hydration.
  if (document.readyState !== 'complete') {
    await new Promise<void>((r) =>
      window.addEventListener('load', () => r(), { once: true }),
    );
  }
  await new Promise((r) => setTimeout(r, 500));

  const stop = record({
    emit,
    collectFonts: true,
    checkoutEveryNms: CHECKOUT_INTERVAL,
  });

  if (stop) {
    s.recording = true;
    s.stopFn = () => {
      stop();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush(); // send any remaining events
      s.recording = false;
      s.stopFn = null;
    };
  }
}
