/**
 * SPA navigation tracking.
 *
 * Reports the in-frame route to the parent editor whenever it changes, so the
 * editor's preview address bar can reflect where the previewed app actually is.
 * The preview iframe is cross-origin, so the parent can't read `location`
 * directly — this is the only place that can observe it.
 *
 * Emits `{ channel, command: 'location', url }` (url = pathname+search+hash) on
 * pushState/replaceState (wrapped), popstate, hashchange, and once on init (to
 * report the landing route after a full-document navigation/reload). Deduped on
 * the last emitted URL so the editor→navigate→pushState round-trip and chatty
 * replaceState calls (e.g. mirror/record.ts) don't spam the parent.
 */

import { getState } from './state';
import { markNavigation } from './recording/session-recorder';

const CHANNEL = 'mindstudio-browser-agent';

export function initNavigationTracking(): void {
  // Patch history + attach listeners exactly once — matches the monkey-patch
  // sentinel convention used by capture/errors.ts, capture/interactions.ts, etc.
  if ((window as any).__ms_nav_patched) {
    return;
  }
  (window as any).__ms_nav_patched = true;

  const emit = () => {
    const url = location.pathname + location.search + location.hash;
    const s = getState();
    if (url === s.nav.lastUrl) {
      return;
    }
    s.nav.lastUrl = url;
    markNavigation(url);
    if (window.parent !== window) {
      // Navigation API (Chromium only, untyped in our DOM lib) lets the editor
      // grey out back/forward at history boundaries. Omitted where unavailable
      // → the editor falls back to always-enabled.
      const nav = (window as any).navigation;
      window.parent.postMessage(
        {
          channel: CHANNEL,
          command: 'location',
          url,
          canGoBack: nav ? !!nav.canGoBack : undefined,
          canGoForward: nav ? !!nav.canGoForward : undefined,
        },
        '*',
      );
    }
  };

  // Wrap the history writes SPA routers use (they fire no event on their own).
  const origPushState = history.pushState.bind(history);
  history.pushState = function (...args: Parameters<History['pushState']>) {
    origPushState(...args);
    emit();
  };
  const origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (
    ...args: Parameters<History['replaceState']>
  ) {
    origReplaceState(...args);
    emit();
  };

  // Back/forward (and our own synthetic popstate from inbound `navigate`) + hash.
  window.addEventListener('popstate', emit);
  window.addEventListener('hashchange', emit);

  // Report the initial/landing route (covers full-document navigations: a hard
  // link or form post reloads the doc, the agent re-inits, and this fires).
  emit();
}
