//////////////////////////////////////////////////////////////////////////////
// The page a visitor gets when this box cannot serve the preview yet
//////////////////////////////////////////////////////////////////////////////
//
// The box is reachable long before the app is: the platform marks the session running as soon as
// the pod is up, and everything after that — restoring the home snapshot, installing, starting the
// dev server — happens while the public preview host already routes here. That window is the one a
// visitor is MOST likely to land in, so it gets a real page rather than a line of placeholder text.
//
// DELIBERATELY A COPY of youai-api `src/sandboxProxy/previewPlaceholder.ts`, which answers the same
// question one hop earlier (no box at all). Two processes in two repos serve one origin, so the
// visual language and the `X-Remy-Preview-Placeholder` marker are duplicated instead of shared —
// the alternative is a package dependency between the platform and the untrusted box, which is a
// much worse trade than keeping two short files in step.

import type http from 'node:http';

/** `starting`: no dev server yet. `unavailable`: there is one and it refused the request. */
export type PreviewPlaceholderState = 'starting' | 'unavailable';

const PLACEHOLDER_HEADER = 'X-Remy-Preview-Placeholder';

/** Matches the proxy's page: check often enough that the app appears about when it is ready. */
const POLL_INTERVAL_MS = 2_500;
const POLL_CEILING_MS = 5 * 60_000;

const COPY: Record<
  PreviewPlaceholderState,
  {
    status: number;
    title: string;
    eyebrow: string;
    heading: string;
    body: string;
  }
> = {
  starting: {
    status: 503,
    title: 'Preview starting',
    eyebrow: 'Starting',
    heading: 'This preview is starting up',
    body: 'The development environment is booting. This page will load the app as soon as it is ready.',
  },
  unavailable: {
    status: 502,
    title: 'Preview unavailable',
    eyebrow: 'Unavailable',
    heading: 'The development server is not responding',
    body: 'The environment is running, but its server refused the request. If it comes back, this page will load the app automatically.',
  },
};

const wantsPage = (req: http.IncomingMessage): boolean =>
  req.method !== 'HEAD' &&
  String(req.headers.accept ?? '').includes('text/html');

/** Respond with the placeholder. No-op if something already answered. */
export function sendPreviewPlaceholder(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: PreviewPlaceholderState,
): void {
  if (res.headersSent) {
    return;
  }
  const copy = COPY[state];
  const page = wantsPage(req);

  res.writeHead(copy.status, {
    'Content-Type': page
      ? 'text/html; charset=utf-8'
      : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    [PLACEHOLDER_HEADER]: state,
  });
  res.end(page ? renderPage(state) : `${copy.heading}.\n`);
}

function renderPage(state: PreviewPlaceholderState): string {
  const copy = COPY[state];

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${copy.title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100svh; display: grid; place-items: center;
    padding: 24px; background: #fbfbfa; color: #1b1b1a;
    font: 400 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  main { max-width: 30rem; text-align: center; }
  .eyebrow { display: inline-flex; align-items: center; gap: 7px; margin: 0 0 14px;
    font: 500 11px/1 ui-monospace, SFMono-Regular, monospace;
    letter-spacing: .13em; text-transform: uppercase; color: #8a8a85; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor;
    animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: .25 } 50% { opacity: 1 } }
  h1 { margin: 0 0 10px; font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
  p { margin: 0; color: #5c5c58; }
  .action { display: inline-block; margin-top: 22px; padding: 9px 16px; border: 0;
    border-radius: 8px; background: #1b1b1a; color: #fbfbfa; font: inherit;
    font-size: 14px; font-weight: 500; cursor: pointer; }
  #waiting { margin-top: 18px; font-size: 13px; color: #8a8a85; }
  [hidden] { display: none !important; }
  @media (prefers-color-scheme: dark) {
    body { background: #121213; color: #f2f2f0; }
    p { color: #a9a9a6; }
    .eyebrow, #waiting { color: #78787c; }
    .action { background: #f2f2f0; color: #121213; }
  }
</style>
</head><body>
<main>
  <p class="eyebrow"><span class="dot"></span>${copy.eyebrow}</p>
  <h1>${copy.heading}</h1>
  <p>${copy.body}</p>
  <p id="waiting">Checking for the preview.</p>
  <button class="action" id="retry" hidden>Check again</button>
</main>
<script>
(function () {
  var state = ${JSON.stringify(state)};
  var interval = ${POLL_INTERVAL_MS};
  var deadline = Date.now() + ${POLL_CEILING_MS};
  var waiting = document.getElementById('waiting');
  var retry = document.getElementById('retry');

  retry.addEventListener('click', function () { location.reload(); });

  function check() {
    if (Date.now() > deadline) {
      waiting.hidden = true;
      retry.hidden = false;
      return;
    }
    fetch(location.href, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        var placeholder = res.headers.get('x-remy-preview-placeholder');
        // No marker: the app itself answered. A different one: the box moved on
        // (starting -> gone, or the platform is answering now). Either way, reload.
        if (!placeholder || placeholder !== state) { location.reload(); return; }
        setTimeout(check, interval);
      })
      .catch(function () { setTimeout(check, interval); });
  }

  setTimeout(check, interval);
})();
</script>
</body></html>`;
}
