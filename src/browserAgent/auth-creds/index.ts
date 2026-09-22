/**
 * Dev-mode auth-credentials widget.
 *
 * Watches the page for auth-shaped inputs (email/phone identifier, OTP code)
 * and shows a small corner widget that explains the dev-mode auth situation
 * and offers one-click autofill + submit of the hardcoded test creds:
 *   - email apps:  remy@mindstudio.ai
 *   - phone apps:  +15555555555
 *   - OTP code:    123456
 *
 * Clicking the identifier button auto-chains the OTP step so a single click
 * signs the user all the way in. The code screen only appears after a
 * navigation/re-render, and OTP UIs vary (one multi-char input vs. a row of
 * single-char boxes), so the chain doesn't hinge on a single well-timed
 * mutation: while awaiting the code it polls, fills whatever code field shows
 * up, verifies the value stuck, and retries a bounded number of times. The
 * widget stays in a loading state throughout — bridging the blank gap between
 * the identifier submit and the code screen — and disappears once auth is done.
 *
 * If the flow stalls past an 8-second backstop, the chain resets so the user
 * can recover or dismiss.
 *
 * Only runs in dev (needs __MINDSTUDIO__.releaseId), in iframe / standalone
 * modes. Skipped in the sandbox-headless browser so it never interferes with
 * automation screenshots.
 */

import { getMode, isSandboxBrowser } from '../commands/ws-client';
import { getState } from '../state';
import { detectAuthInputs, type OtpTarget } from './detect';
import { fillOtp, readOtp, submitOtp } from './fill';
import { DEV_OTP_CODE, hideWidget, showOrUpdateWidget } from './widget';

const DISMISS_KEY = '__ms_dev_creds_dismissed';
const DEBOUNCE_MS = 150;
// Overall backstop: if the chain hasn't resolved this long after the
// identifier submit, reset so the user isn't left with a stuck spinner.
const AUTO_CHAIN_TIMEOUT_MS = 8_000;
// While awaiting the code, re-check on this cadence rather than relying on a
// mutation firing (the code field can appear via a class toggle or animation
// the observer doesn't watch).
const CODE_POLL_MS = 250;
// Cap how many times we (re)fill a code field that won't take the value, so a
// stubborn input can't cause an unbounded refill loop.
const MAX_CODE_ATTEMPTS = 8;
// Consecutive no-input polls tolerated while awaiting the code before we treat
// it as "signed in already / no code step" and tear down (~1.5s at CODE_POLL_MS).
const BLANK_POLL_LIMIT = 6;
// The interface bundle sets `__MINDSTUDIO__.releaseId` on its own schedule,
// which can land after this agent boots. Poll for it (see initAuthCredsWidget)
// rather than reading it once and bailing — that raced the assignment and left
// the widget permanently disabled on loads where the agent won.
const RELEASE_POLL_MS = 200;
const RELEASE_MAX_WAIT_MS = 10_000;

export function initAuthCredsWidget(): void {
  // Defensive: backfill if the state container was populated by a previous
  // bundle that predates this slice (devtools hot-swap scenario).
  const root = getState();
  if (!root.authCredsWidget) {
    root.authCredsWidget = {
      initialized: false,
      host: null,
      observer: null,
      debounceTimer: null,
      awaitingCode: false,
      awaitingCodeTimer: null,
      codePollTimer: null,
      codeAttempts: 0,
      codeSubmitted: false,
      codeSeenCount: 0,
      blankPolls: 0,
    };
  }
  const s = root.authCredsWidget;
  if (s.initialized) {
    return;
  }
  s.initialized = true;

  if (isSandboxBrowser()) {
    return;
  }

  const mode = getMode();
  if (mode !== 'iframe' && mode !== 'standalone') {
    return;
  }

  // Dev gate: only run once the interface has stamped `__MINDSTUDIO__.releaseId`.
  // It may not be present yet at boot, so wait for it instead of bailing — a
  // one-shot check here (with `initialized` already latched above) is what made
  // the widget "only appear sometimes."
  waitForReleaseThenObserve(Date.now() + RELEASE_MAX_WAIT_MS);
}

function waitForReleaseThenObserve(deadline: number): void {
  const ms = (
    window as unknown as {
      __MINDSTUDIO__?: { releaseId?: unknown };
    }
  ).__MINDSTUDIO__;

  if (typeof ms?.releaseId !== 'string') {
    // Keep waiting up to the deadline. If releaseId never lands this isn't a
    // dev preview (e.g. production), so give up quietly without observing.
    if (Date.now() < deadline) {
      setTimeout(() => waitForReleaseThenObserve(deadline), RELEASE_POLL_MS);
    }
    return;
  }

  const s = getState().authCredsWidget;
  if (s.observer) {
    return;
  }

  const observer = new MutationObserver(scheduleEvaluate);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      'type',
      'autocomplete',
      'inputmode',
      'maxlength',
      'style',
      'hidden',
      'class',
    ],
  });
  s.observer = observer;

  scheduleEvaluate();
}

function scheduleEvaluate(): void {
  const s = getState().authCredsWidget;
  if (s.debounceTimer) {
    clearTimeout(s.debounceTimer);
  }
  s.debounceTimer = setTimeout(() => {
    s.debounceTimer = null;
    evaluate();
  }, DEBOUNCE_MS);
}

function evaluate(): void {
  const s = getState().authCredsWidget;

  if (isDismissed()) {
    clearAwaitingCode();
    teardownWidget();
    return;
  }

  const inputs = detectAuthInputs();

  if (!inputs.identifier && !inputs.code) {
    // No auth inputs visible. While auto-chaining and before we've submitted a
    // code, this is almost always the blank gap between the identifier submit
    // and the code screen rendering — keep waiting a few polls. Otherwise (or
    // once the code was submitted) the flow is done: clear state and remove.
    if (s.awaitingCode && !s.codeSubmitted && s.blankPolls < BLANK_POLL_LIMIT) {
      s.blankPolls++;
      showLoading();
      return;
    }
    clearAwaitingCode();
    teardownWidget();
    return;
  }

  s.blankPolls = 0;

  // Auto-chain mode: keep the widget in a loading state and drive the code step
  // to completion. We deliver the code exactly once, then stop touching the
  // field. Scaffolded OTP inputs auto-submit the moment they're complete, and
  // every submit consumes the one-time verification server-side — so if we
  // re-fill after the app clears the field (which it does on its verify /
  // error re-render), that fires a *second* verify against an already-spent
  // code. That returns 400 `verification_expired`, which the app flashes as an
  // error — the exact "code keeps erroring as it's entered" the loop produced.
  // `codeSubmitted` latches the instant the full code lands in the field; from
  // there the app owns verification + navigation, and the blank-poll teardown
  // above cleans up once it routes away.
  if (s.awaitingCode) {
    if (inputs.code && !s.codeSubmitted) {
      const current = readOtp(inputs.code);
      if (current === DEV_OTP_CODE) {
        // The field already holds the full code without us having filled it
        // (e.g. a pre-populated / browser-autofilled input): submit once. We
        // latch below the moment our own fill takes, so we never re-enter here
        // to double-submit after filling.
        submitOtp(inputs.code);
        s.codeSubmitted = true;
      } else {
        // Let a freshly-appearing segmented row settle before filling: only
        // act once its visible cell count matches the previous poll, so we
        // never dump digits into a half-rendered / mid-animation group. A
        // single input needs no settling.
        const count = inputs.code.cells.length;
        const settled = !inputs.code.segmented || count === s.codeSeenCount;
        s.codeSeenCount = count;
        if (settled && s.codeAttempts < MAX_CODE_ATTEMPTS) {
          s.codeAttempts++;
          // fillOtp fills and submits. Latch as soon as the value takes so we
          // never fill a second time — even if the app blanks the field on its
          // next render, re-filling would re-submit the spent code.
          const filled = fillOtp(inputs.code, DEV_OTP_CODE);
          if (filled === DEV_OTP_CODE) {
            s.codeSubmitted = true;
          }
        }
      }
    } else if (!inputs.code) {
      s.codeSeenCount = 0;
    }
    showLoading();
    return;
  }

  // Normal mode: show the manual button(s) for whatever inputs are visible.
  showOrUpdateWidget({
    identifier: inputs.identifier,
    identifierKind: inputs.identifierKind,
    code: codeButtonTarget(inputs.code),
    loading: false,
    onDismiss: dismiss,
    onIdentifierFilled,
  });
}

// The manual "Continue with <code>" button is only useful when the field can
// actually take a value. Apps commonly keep the code input in the DOM from the
// first frame but `disabled` until a code is sent (e.g. one transparent input
// behind painted slots); offering a button then would fill a dead field. Gate
// only the manual affordance — the auto-chain uses the raw detection so it can
// still fill the moment the field is armed.
function codeButtonTarget(code: OtpTarget | null): OtpTarget | null {
  if (!code) {
    return null;
  }
  return code.cells.some((cell) => !cell.disabled) ? code : null;
}

function showLoading(): void {
  showOrUpdateWidget({
    identifier: null,
    identifierKind: null,
    code: null,
    loading: true,
    onDismiss: dismiss,
    onIdentifierFilled,
  });
}

function onIdentifierFilled(): void {
  const s = getState().authCredsWidget;
  s.awaitingCode = true;
  s.codeAttempts = 0;
  s.codeSubmitted = false;
  s.codeSeenCount = 0;
  s.blankPolls = 0;

  if (s.awaitingCodeTimer) {
    clearTimeout(s.awaitingCodeTimer);
  }
  s.awaitingCodeTimer = setTimeout(() => {
    // Backstop: the code never showed, or kept failing to take. Reset so the
    // user sees the manual buttons again rather than a stuck spinner.
    clearAwaitingCode();
    scheduleEvaluate();
  }, AUTO_CHAIN_TIMEOUT_MS);

  // Poll for the code screen instead of waiting on a mutation that may never
  // fire (class-toggle reveals, CSS-animated mounts, etc.).
  if (s.codePollTimer) {
    clearInterval(s.codePollTimer);
  }
  s.codePollTimer = setInterval(evaluate, CODE_POLL_MS);

  // Immediately swap the widget into loading state so the user sees the
  // transition without a flash of empty corner.
  showLoading();
}

function clearAwaitingCode(): void {
  const s = getState().authCredsWidget;
  s.awaitingCode = false;
  s.codeAttempts = 0;
  s.codeSubmitted = false;
  s.codeSeenCount = 0;
  s.blankPolls = 0;
  if (s.awaitingCodeTimer) {
    clearTimeout(s.awaitingCodeTimer);
    s.awaitingCodeTimer = null;
  }
  if (s.codePollTimer) {
    clearInterval(s.codePollTimer);
    s.codePollTimer = null;
  }
}

function teardownWidget(): void {
  hideWidget();
}

function dismiss(): void {
  clearAwaitingCode();
  try {
    sessionStorage.setItem(DISMISS_KEY, '1');
  } catch {
    // sessionStorage unavailable — fall back to in-memory teardown.
  }
  teardownWidget();
}

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}
