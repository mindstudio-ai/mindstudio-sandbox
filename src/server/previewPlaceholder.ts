//////////////////////////////////////////////////////////////////////////////
// The page a visitor gets when this box cannot serve the preview yet
//////////////////////////////////////////////////////////////////////////////
//
// The box is reachable long before the app is: the platform marks the session running as soon as
// the pod is up, and everything after that — restoring the home snapshot, installing, starting the
// dev server — happens while the public preview host already routes here. That window is the one a
// visitor is MOST likely to land in, so it gets a real page rather than a line of placeholder text.
//
// DELIBERATELY A COPY of youai-api, which answers the same question one hop earlier (no box at all).
// The page is its `src/common/StandalonePage/` template rendered for these two states; the header
// and poll contract is its `src/sandboxProxy/previewPlaceholder.ts`. Two processes in two repos
// serve one origin, so the tokens, rules, mark and the `X-Remy-Preview-Placeholder` marker are
// duplicated instead of shared — the alternative is a package dependency between the platform and
// the untrusted box, which is a much worse trade than keeping two short files in step. When the
// template changes there, it changes here; the check is that the two `starting` pages render
// byte-identically.
//
// Self-contained: tokens, rules and the Remy mark are inline. The one request the page makes is for
// Switzer, and `display=swap` makes that optional.

import type http from 'node:http';

/** `starting`: no dev server yet. `unavailable`: there is one and it refused the request. */
export type PreviewPlaceholderState = 'starting' | 'unavailable';

const PLACEHOLDER_HEADER = 'X-Remy-Preview-Placeholder';

/** Matches the proxy's page: check often enough that the app appears about when it is ready. */
const POLL_INTERVAL_MS = 2_500;
const POLL_CEILING_MS = 5 * 60_000;

// One line each. The heading is the whole message; the liveness line says the rest.
const COPY: Record<
  PreviewPlaceholderState,
  {
    status: number;
    title: string;
    eyebrow: string;
    heading: string;
  }
> = {
  starting: {
    status: 503,
    title: 'Preview starting',
    eyebrow: 'Starting',
    heading: 'This preview is starting up',
  },
  unavailable: {
    status: 502,
    title: 'Preview unavailable',
    eyebrow: 'Unavailable',
    heading: 'The development server is not responding',
  },
};

/**
 * The small mark beside the eyebrow. Only `starting` is in progress, so only it moves;
 * `unavailable` is the failure and gets the danger dot.
 */
const SIGNAL: Record<PreviewPlaceholderState, 'spinner' | 'danger'> = {
  starting: 'spinner',
  unavailable: 'danger',
};

/** The poll script's DOM hooks. Named once so the script and the page agree. */
const WAITING_ID = 'waiting';
const RETRY_ID = 'retry';

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

//////////////////////////////////////////////////////////////////////////////
// The StandalonePage template, copied — see the header. Nothing below is this
// file's own design; it mirrors youai-api `src/common/StandalonePage/`.
//////////////////////////////////////////////////////////////////////////////

// tokens.ts — the ONE place a hex value may appear.
const TOKENS = `
:root {
  color-scheme: light dark;
  --font-ui: 'Switzer', ui-sans-serif, system-ui, -apple-system, sans-serif;
  --bg-canvas: #fafafa;
  --bg-raised: #ffffff;
  --border-default: #e0e0e0;
  --border-strong: #cfcfcf;
  --text-primary: #141414;
  --text-secondary: #6b6b6b;
  --text-tertiary: #8c8c8c;
  --text-inverse: #fafafa;
  --accent: #a52b2b;
  --action-primary: #141414;
  --action-primary-hover: #2c2c2c;
  --surface-hover: #f4f4f4;
  --danger-solid: #da3a2d;
  --focus-ring: rgba(165, 43, 43, 0.3);
  --radius-control: 6px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-canvas: #141414;
    --bg-raised: #1c1c1c;
    --border-default: #2c2c2c;
    --border-strong: #3a3a3a;
    --text-primary: #fafafa;
    --text-secondary: #9a9a9a;
    --text-tertiary: #6e6e6e;
    --text-inverse: #141414;
    --accent: #e0726f;
    --action-primary: #fafafa;
    --action-primary-hover: #e6e6e6;
    --surface-hover: #202020;
    --danger-solid: #e8584b;
    --focus-ring: rgba(224, 114, 111, 0.36);
  }
}
`;

// styles.ts — tokens only.
const RULES = `
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100svh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--bg-canvas);
  color: var(--text-primary);
  font: 400 14px/1.5 var(--font-ui);
  -webkit-font-smoothing: antialiased;
}
main {
  max-width: 30rem;
  text-align: center;
}
.mark {
  display: block;
  width: 30px;
  height: 30px;
  margin: 0 auto 28px;
  color: var(--accent);
}
.overline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--text-primary);
}
.actions {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 24px;
}
.footer { margin-top: 20px; }
.liveness {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-tertiary);
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  font: 500 13px/1 var(--font-ui);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.btn:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.btn-primary {
  background: var(--action-primary);
  border-color: var(--action-primary);
  color: var(--text-inverse);
}
.btn-primary:hover {
  background: var(--action-primary-hover);
  border-color: var(--action-primary-hover);
}
.btn-secondary {
  background: var(--bg-raised);
  border-color: var(--border-default);
  color: var(--text-primary);
}
.btn-secondary:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}
.signal-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
.signal-danger {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--danger-solid);
}
@keyframes spin { to { transform: rotate(360deg); } }
[hidden] { display: none !important; }
`;

// remyMark.ts — the design system's published path data, `currentColor` so the accent colours it.
const REMY_MARK_SVG =
  '<svg class="mark" viewBox="0 0 1000 1000" width="30" height="30" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M 0 0 H 1000 V 250 H 250 V 1000 H 0 Z"/>' +
  '<path fill="currentColor" d="M 680.00 440.00 L 618.89 440.05 L 599.38 440.21 L 585.22 440.46 L 573.71 440.82 L 563.86 441.29 L 555.17 441.86 L 547.36 442.53 L 540.23 443.31 L 533.67 444.19 L 527.58 445.18 L 521.89 446.28 L 516.56 447.48 L 511.55 448.80 L 506.82 450.22 L 502.35 451.76 L 498.11 453.42 L 494.10 455.19 L 490.28 457.08 L 486.66 459.09 L 483.22 461.22 L 479.94 463.49 L 476.83 465.88 L 473.88 468.40 L 471.07 471.07 L 468.40 473.88 L 465.88 476.83 L 463.49 479.94 L 461.22 483.22 L 459.09 486.66 L 457.08 490.28 L 455.19 494.10 L 453.42 498.11 L 451.76 502.35 L 450.22 506.82 L 448.80 511.55 L 447.48 516.56 L 446.28 521.89 L 445.18 527.58 L 444.19 533.67 L 443.31 540.23 L 442.53 547.36 L 441.86 555.17 L 441.29 563.86 L 440.82 573.71 L 440.46 585.22 L 440.21 599.38 L 440.05 618.89 L 440.00 680.00 V 1000 H 1000 V 440 Z"/>' +
  '</svg>';

// fonts.ts — Switzer with `display=swap`: the fallback stack renders first, the face arrives if it can.
const FONT_LINKS =
  '<link rel="preconnect" href="https://api.fontshare.com" crossorigin>' +
  '<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>' +
  '<link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&amp;display=swap">';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * renderStandalonePage, specialised to this file's fixed shape: mark, eyebrow with its signal,
 * heading, then the footer — the liveness line and the hidden "Check again". No actions row: the
 * box has no editor URL to offer.
 */
function renderPage(state: PreviewPlaceholderState): string {
  const copy = COPY[state];
  const overline = `<p class="overline"><span class="signal-${SIGNAL[state]}" aria-hidden="true"></span>${escapeHtml(copy.eyebrow)}</p>`;
  const footer = `<div class="footer"><p class="liveness" id="${WAITING_ID}">Checking for the preview.</p><button type="button" class="btn btn-secondary" id="${RETRY_ID}" hidden>Check again</button></div>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(copy.title)}</title>
${FONT_LINKS}
<style>${TOKENS}${RULES}</style>
</head><body>
<main>
${REMY_MARK_SVG}
${overline}
<h1>${escapeHtml(copy.heading)}</h1>
${footer}
</main>
<script>${pollScript(state)}</script></body></html>`;
}

/**
 * HEAD this same URL until something other than this page answers. No marker means the app itself
 * answered. A DIFFERENT marker means the box moved on (starting → gone, or the platform is answering
 * now), so reload to show what is true now. After the ceiling, hand the decision to the visitor.
 */
function pollScript(state: PreviewPlaceholderState): string {
  return `
(function () {
  var state = ${JSON.stringify(state)};
  var interval = ${POLL_INTERVAL_MS};
  var deadline = Date.now() + ${POLL_CEILING_MS};
  var waiting = document.getElementById(${JSON.stringify(WAITING_ID)});
  var retry = document.getElementById(${JSON.stringify(RETRY_ID)});

  retry.addEventListener('click', function () { location.reload(); });

  function stop() {
    waiting.hidden = true;
    retry.hidden = false;
  }

  function check() {
    if (Date.now() > deadline) { stop(); return; }
    fetch(location.href, { method: 'HEAD', cache: 'no-store' })
      .then(function (res) {
        var placeholder = res.headers.get(${JSON.stringify(PLACEHOLDER_HEADER)});
        if (!placeholder || placeholder !== state) { location.reload(); return; }
        setTimeout(check, interval);
      })
      .catch(function () { setTimeout(check, interval); });
  }

  setTimeout(check, interval);
})();
`;
}
