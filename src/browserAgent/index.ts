/**
 * MindStudio Browser Agent
 *
 * Injected into dev preview pages via <script src>. Captures browser events
 * (console, errors, network failures, interactions) and sends them to the
 * dev tunnel proxy for logging. Also provides a DOM snapshot API for AI agents.
 *
 * Idempotent — safe to load multiple times (HMR, navigation, iframe reload).
 */

import { initTransport } from './transport';
import { initConsoleCapture } from './capture/console';
import { initErrorCapture } from './capture/errors';
import { initNetworkCapture } from './capture/network';
import { initInteractionCapture } from './capture/interactions';
import { initXhrCapture } from './capture/xhr';
import { initWebSocket } from './commands/ws-client';
import {
  initCursor,
  hide as hideCursor,
  restore as restoreCursor,
} from './cursor/cursor';
import { initTouch } from './cursor/touch';
import { initIframeBridge } from './iframe-bridge';
import { initNavigationTracking } from './navigation';
import { initMirrorRecording } from './mirror/record';
import { initFontFixer } from './fonts';
import { initAuthCredsWidget } from './auth-creds';
import { takeSnapshot, takeSnapshotSync, getRefMap } from './snapshot/walker';
import { executeSteps } from './commands/executor';
import { resolveElement } from './commands/resolve';
import { computeStyleMap } from './commands/style-map';
import { capturePageImage } from './commands/screenshot';

// Prevent double-initialization. The global doubles as a public API surface
// so external drivers (e.g. the tunnel's CDP screenshot path) can call into
// the agent via `page.evaluate`.
if (!(window as any).__MINDSTUDIO_BROWSER_AGENT__) {
  (window as any).__MINDSTUDIO_BROWSER_AGENT__ = {
    takeSnapshot,
    takeSnapshotSync,
    getRefMap,
    executeSteps,
    resolveElement,
    computeStyleMap,
    capturePageImage,
    // Cursor visibility around externally-driven captures. The tunnel's CDP
    // screenshot path photographs real pixels, so the agent-cursor overlay
    // (which capturePageImage hides internally) would land in the image —
    // these let that path use the same snapshot-hide/restore state machine.
    hideCursor,
    restoreCursor,
  };

  initTransport();
  initConsoleCapture();
  initErrorCapture();
  initNetworkCapture();
  initXhrCapture();
  initInteractionCapture();
  initWebSocket();
  initIframeBridge(); // before cursor/touch — reads query params that gate their init
  initNavigationTracking();
  initCursor();
  initTouch();
  initMirrorRecording();
  initFontFixer();
  initAuthCredsWidget();

  // Notify parent that the agent is ready to receive messages
  if (window.parent !== window) {
    window.parent.postMessage(
      { channel: 'mindstudio-browser-agent', command: 'ready' },
      '*',
    );
  }
}

// Always export the API (even on re-load) so it's accessible
export {
  takeSnapshot,
  takeSnapshotSync,
  getRefMap,
  executeSteps,
  resolveElement,
};
