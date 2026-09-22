/**
 * Unified postMessage bridge for the browser agent.
 *
 * Single listener that routes all incoming messages from the parent frame
 * (MindStudio IDE) to the appropriate module.
 *
 * All commands use: { channel: 'mindstudio-browser-agent', command: string, ... }
 *
 * Responses sent to parent:
 *   { channel: 'mindstudio-browser-agent', command: 'capture-page-result', image: '...' }
 */

import { getState } from './state';
import { activateTouch, deactivateTouch } from './cursor/touch';
import { setMobileStyle, setForcedVisibility } from './cursor/cursor';
import { capturePageImage } from './commands/screenshot';

const CHANNEL = 'mindstudio-browser-agent';

export function initIframeBridge(): void {
  const s = getState();

  // Determine mobile/desktop: sessionStorage (persisted across nav) >
  // query param > viewport width as fallback.
  const params = new URLSearchParams(window.location.search);
  s.zoom.pipMode = params.get('display-mode') === 'pip';
  s.zoom.mobilePreview =
    params.get('preview') === 'mobile' || window.innerWidth < 768;
  try {
    const pip = sessionStorage.getItem('__ms_pip');
    if (pip === '1') {
      s.zoom.pipMode = true;
    } else if (pip === '0') {
      s.zoom.pipMode = false;
    }
    const mobile = sessionStorage.getItem('__ms_mobile');
    if (mobile === '1') {
      s.zoom.mobilePreview = true;
    } else if (mobile === '0') {
      s.zoom.mobilePreview = false;
    }
  } catch {}

  // Idempotent — don't add a second listener on HMR reload
  if (s.messages.handler) {
    return;
  }

  s.messages.handler = async (e: MessageEvent) => {
    // Skip self-sent messages (e.g. our own capture-page-result postMessage)
    if (e.source === window) {
      return;
    }

    const data = e.data;
    if (!data || typeof data.command !== 'string') {
      return;
    }
    if (data.channel !== CHANNEL) {
      return;
    }

    switch (data.command) {
      // --- Full-page capture (Add Notes flow) ---
      case 'capture-page': {
        console.info('[capture-page] request received');
        try {
          const result = await capturePageImage();
          console.info('[capture-page] capture complete', {
            width: result.width,
            height: result.height,
            scale: result.scale,
            blobBytes: result.blob.size,
          });
          window.parent.postMessage(
            { channel: CHANNEL, command: 'capture-page-result', ...result },
            '*',
          );
          console.info('[capture-page] result posted to parent');
        } catch (err) {
          console.error('[capture-page] capture failed', err);
          window.parent.postMessage(
            {
              channel: CHANNEL,
              command: 'capture-page-result',
              error: err instanceof Error ? err.message : 'Capture failed',
            },
            '*',
          );
        }
        break;
      }

      // --- Cursor ---
      case 'cursor-show':
        setForcedVisibility('visible');
        break;

      case 'cursor-hide':
        setForcedVisibility('hidden');
        break;

      case 'cursor-auto':
        setForcedVisibility(null);
        break;

      // --- Navigation ---
      case 'navigate':
        if (typeof data.url === 'string') {
          window.history.pushState(null, '', data.url);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }
        break;

      case 'back':
        // Real history traversal — fires a native popstate that
        // navigation.ts already reports back to the parent.
        window.history.back();
        break;

      case 'forward':
        window.history.forward();
        break;

      // --- Healthcheck ---
      case 'healthcheck': {
        const ws = getState().ws;
        window.parent.postMessage(
          {
            channel: CHANNEL,
            command: 'healthcheck-reply',
            wsConnected: !!(ws.ws && ws.ws.readyState === WebSocket.OPEN),
            url: location.href,
          },
          '*',
        );
        break;
      }

      // --- Display mode ---
      case 'display-mode-pip':
        s.zoom.pipMode = true;
        try {
          sessionStorage.setItem('__ms_pip', '1');
        } catch {}
        break;

      case 'display-mode-full':
        s.zoom.pipMode = false;
        try {
          sessionStorage.setItem('__ms_pip', '0');
        } catch {}
        break;

      // --- Preview mode ---
      case 'preview-mode-mobile':
        s.zoom.mobilePreview = true;
        try {
          sessionStorage.setItem('__ms_mobile', '1');
        } catch {}
        activateTouch();
        setMobileStyle(true);
        break;

      case 'preview-mode-desktop':
        s.zoom.mobilePreview = false;
        try {
          sessionStorage.setItem('__ms_mobile', '0');
        } catch {}
        deactivateTouch();
        setMobileStyle(false);
        break;
    }
  };

  // Forward the push-to-talk key (backtick) release to the parent IDE. When the
  // user holds backtick to dictate in the chat composer and then clicks into
  // this preview, the physical keyup lands here instead of the parent window, so
  // the parent's push-to-talk never sees the release. Bubble it back up over the
  // same channel; the parent gates it to an active recording.
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (e.code === 'Backquote' && window.parent !== window) {
      window.parent.postMessage(
        { channel: CHANNEL, command: 'ptt-keyup' },
        '*',
      );
    }
  });

  window.addEventListener('message', s.messages.handler);
}

export function isPipMode(): boolean {
  return getState().zoom.pipMode;
}
