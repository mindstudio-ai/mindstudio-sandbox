/**
 * Viewport capture for the "Add Notes" flow.
 *
 * Renders the currently visible viewport in a single SnapDOM pass and returns
 * it as a JPEG. The parent frontend (MindStudio IDE) displays the image as
 * the frozen card in the fullscreen annotator — no annotation UI runs inside
 * the page. Users scroll the live preview to what they want to annotate
 * BEFORE snapping; the capture is instant and never touches page scroll.
 *
 * NOT the agent screenshot path. Every capture the AI agent takes runs
 * through CDP in the tunnel (`src/devTunnel/browser/screenshot.ts` — now a
 * sibling in this repo), which renders real pixels instead of reconstructing
 * the DOM. This module only serves the user-facing annotation flow, where the
 * capture must reflect the user's own browser state.
 */

import { snapdom } from '@zumer/snapdom';
import { ensureFontsReady } from '../fonts';
import { getState } from '../state';
import * as cursor from '../cursor/cursor';

const SCALE = 2;

const JPEG_QUALITY = 0.92;

/**
 * Snapdom plugin that injects a slight letter-spacing reduction into the
 * cloned DOM. SVG foreignObject renders text slightly wider than the live
 * DOM, causing wrapping in constrained elements (buttons, badges, etc.).
 * A tiny negative letter-spacing compensates without visible difference.
 */
const textFitPlugin = {
  name: 'text-fit',
  afterClone(ctx: { clone?: Element | null }) {
    if (!ctx.clone) {
      return;
    }
    const doc = ctx.clone.ownerDocument;
    if (!doc) {
      return;
    }
    const style = doc.createElement('style');
    style.textContent = '* { letter-spacing: -0.03px !important; }';
    (ctx.clone as HTMLElement).prepend(style);
  },
};

const SNAP_EXCLUDE = [
  '#__mindstudio-cursor',
  '#__mindstudio-cursor-ripple',
  '#__mindstudio-touch-circle',
];

export interface PageCapture {
  /** JPEG blob — sent to the parent via postMessage structured clone. */
  blob: Blob;
  /** Output image dimensions in device pixels. */
  width: number;
  height: number;
  /** Image pixels per CSS pixel. */
  scale: number;
}

/**
 * Capture the visible viewport as a JPEG.
 * Throws if a capture is already in progress.
 */
export async function capturePageImage(): Promise<PageCapture> {
  const ss = getState().screenshot;
  if (ss.capturing) {
    throw new Error('Capture already in progress');
  }
  ss.capturing = true;

  // Hide the Remy cursor so it doesn't appear in the capture
  cursor.hide();

  try {
    await ensureFontsReady();

    console.info('[capture-page] starting snapdom viewport render');
    const started = performance.now();
    const snap = await snapdom(document.body, {
      embedFonts: true,
      exclude: SNAP_EXCLUDE,
      plugins: [textFitPlugin],
      clip: 'viewport',
      scale: SCALE,
      dpr: 1,
      backgroundColor: '#ffffff',
    });
    const canvas = await snap.toCanvas();
    console.info('[capture-page] snapdom render done', {
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      ms: Math.round(performance.now() - started),
    });

    // toBlob (async encode) rather than toDataURL — the sync base64 encode
    // blocks the page's main thread for hundreds of ms on large captures.
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) =>
          b ? resolve(b) : reject(new Error('Canvas export produced no image')),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });

    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      scale: SCALE,
    };
  } finally {
    ss.capturing = false;
    cursor.restore();
  }
}
