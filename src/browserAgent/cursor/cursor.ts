/**
 * Visible cursor overlay — a large pink arrow with a white outline, a soft
 * shadow and a name tag, plus a press-and-ripple click animation, so the user
 * can watch the AI agent interact with the app in real time and the session
 * recording reads like a screen-recording-app capture.
 *
 * Travel is a CSS transition (one recorded mutation per move); a rAF loop
 * only keeps the cursor glued to its target afterwards, writing when the
 * target actually shifts. Screenshots hide the cursor through a stylesheet the
 * session recorder is told to block, so a capture never blinks it in the
 * replay. Its position survives hard navigations via sessionStorage.
 *
 * Only renders when embedded (window.parent !== window).
 * Cursor and ripple are on document.documentElement (not body).
 */

import { sleep } from '../utils';
import { getState } from '../state';
import { hideCircle, showCircle } from './touch';

const CURSOR_ID = '__mindstudio-cursor';
const RIPPLE_ID = '__mindstudio-cursor-ripple';
const HIDE_STYLE_ID = '__mindstudio-cursor-hide';
const POSITION_KEY = '__ms_cursor';
const POSITION_MAX_AGE_MS = 30_000;
// Cursor travel time. Deliberately wall-clock rather than per-frame: this move is
// awaited before every click, type and select, so it sits on the automation
// critical path. It used to be an exponential lerp toward a 1px threshold, which
// converges in a fixed *frame* count — ~74-96 frames whatever the distance — so
// it cost ~1.4s at 60fps but 12s on a page rendering in software at 7fps, and
// never finished at all if the target element was itself animating. Easing on a
// clock looks identical at 60fps and costs the same everywhere.
//
// The clock scales with distance, within bounds: a 20px hop and a 1200px
// traverse used to take the same 450ms, so short moves crawled and long ones
// flicked across the screen. Now a hop is quick and a traverse takes a beat.
//
// The travel itself is a CSS transition — one recorded mutation per move —
// rather than per-frame writes. The sandbox browser has no GPU and its frame
// rate sags under load, so positions recorded frame by frame there were
// sparse and replayed as jank; a transition is interpolated by whichever
// browser plays the recording, at its own frame rate. The clock still decides
// when the move is over.
const MOVE_MIN_MS = 280;
const MOVE_MAX_MS = 800;
const MOVE_BASE_MS = 220;
const MOVE_MS_PER_PX = 0.55;
// A hand accelerates before it decelerates (easeInOutCubic); ease-out alone
// read as the cursor snapping off its resting spot.
const MOVE_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)';
// After the glide, one short hop closes any gap a layout shift opened under
// the target.
const CORRECTION_MS = 120;
// Click: a quick press, the real click dispatched at the bottom of it, then an
// eased release. The ring ripples out from the tip over the whole gesture.
const PRESS_MS = 90;
const RELEASE_MS = 160;
const RIPPLE_MS = 450;
const RIPPLE_SIZE = 72;
const FADE_DURATION = 300;
const HIDE_DELAY = 2000;
const EDGE_BUFFER = 10;

const NAME_TAG = 'Remy';
const CURSOR_COLOR = '#DD2590';
const TOUCH_CIRCLE_SIZE = 44;

// Drawn at about 1.6x a native arrow. Recordings are desktop viewports watched
// scaled down — roughly 0.3x in a chat embed, 0.5x in a tool view — where the
// old 26px arrow shrank to 8px and the tag to a smudge. Screen-recording apps
// enlarge the cursor 2-3x for the same reason.
const CURSOR_SIZE = 64;
// The artwork is a 31x32 viewBox; the arrow's tip is at (6.73, 5.59) in it.
const CURSOR_VIEWBOX_W = 31;
const CURSOR_VIEWBOX_H = 32;
const TIP = {
  x: (6.73 / CURSOR_VIEWBOX_W) * CURSOR_SIZE,
  y: (5.59 / CURSOR_VIEWBOX_W) * CURSOR_SIZE,
};

// White outline painted *under* the fill (paint-order) so the arrow reads on
// any background without the pink getting thinner; CSS drop-shadows lift it
// off the page. Both scale with the artwork.
const CURSOR_SVG = `<svg width="${CURSOR_SIZE}" height="${Math.round((CURSOR_SIZE * CURSOR_VIEWBOX_H) / CURSOR_VIEWBOX_W)}" viewBox="0 0 ${CURSOR_VIEWBOX_W} ${CURSOR_VIEWBOX_H}" fill="none" xmlns="http://www.w3.org/2000/svg" style="display: block; overflow: visible; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.28)) drop-shadow(0 4px 8px rgba(0,0,0,0.22));">
<path d="M12.5448 26L6.72762 5.59339L26 14.8132L17.1816 17.9377L12.5448 26Z" fill="${CURSOR_COLOR}" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" paint-order="stroke"/>
</svg>`;

const TAG_STYLE = `
    background: ${CURSOR_COLOR};
    color: white;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
    letter-spacing: 0.3px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2), 0 3px 8px rgba(0,0,0,0.18);
    transition: opacity 200ms ease;
`;

// The container element is a zero-size point at the target; everything visible
// hangs off this body. Press/release animate the body's transform (its origin
// is the tip) so they never collide with the container's own left/top
// transition.
//
// Desktop: arrow + name tag to its lower right. Offset by the tip, so the tip
// — not the artwork's corner — lands on the target point and on the ripple's
// centre.
const DESKTOP_INNER = `
  <div data-cursor-body style="
    position: absolute;
    left: ${-TIP.x}px;
    top: ${-TIP.y}px;
    transform-origin: ${TIP.x}px ${TIP.y}px;
  ">
    ${CURSOR_SVG}
    <div data-cursor-tag style="
      position: absolute;
      left: ${Math.round(CURSOR_SIZE * 0.82)}px;
      top: ${Math.round(CURSOR_SIZE * 0.58)}px;
      font-size: 15px;
      padding: 6px 10px;
      border-radius: 6px;
      ${TAG_STYLE}
    ">${NAME_TAG}</div>
  </div>
`;

// Mobile: touch circle centred on the target + name tag below it.
const MOBILE_INNER = `
  <div data-cursor-body style="
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
  ">
    <div style="
      position: absolute;
      left: 0;
      top: 0;
      width: ${TOUCH_CIRCLE_SIZE}px;
      height: ${TOUCH_CIRCLE_SIZE}px;
      border-radius: 50%;
      border: 2px solid ${CURSOR_COLOR};
      background: rgba(221, 37, 144, 0.08);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.9), 0 2px 6px rgba(0, 0, 0, 0.2);
      transform: translate(-50%, -50%);
    "></div>
    <div data-cursor-tag style="
      position: absolute;
      left: 0;
      top: ${TOUCH_CIRCLE_SIZE / 2 + 8}px;
      transform: translateX(-50%);
      font-size: 13px;
      padding: 5px 8px;
      border-radius: 5px;
      ${TAG_STYLE}
    ">${NAME_TAG}</div>
  </div>
`;

/** The point the tip lands on: the element's centre, or — for text entry — a
 *  point in its left third, so the arrow body doesn't sit over what gets typed. */
export type Anchor = 'center' | 'text';

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initCursor(): void {
  if (window.parent === window) {
    return;
  }
  createCursorElements();
}

function createCursorElements(): void {
  const s = getState().cursor;

  // Adopt the existing elements rather than bailing. Returning early here left
  // `s.el` null whenever the DOM nodes outlived the state (moveTo's self-heal
  // nulls `s.el` before calling us, and setForcedVisibility calls us with no
  // state at all), and every consumer then treats a null `s.el` as "no cursor" —
  // so the cursor silently stopped animating and moveTo returned instantly.
  const existing = document.getElementById(CURSOR_ID);
  if (existing) {
    s.el = existing as HTMLDivElement;
    s.rippleEl = document.getElementById(RIPPLE_ID) as HTMLDivElement | null;
    ensureCaptureHideStyle();
    return;
  }

  const mobile = getState().zoom.mobilePreview;

  const el = document.createElement('div');
  el.id = CURSOR_ID;
  el.innerHTML = mobile ? MOBILE_INNER : DESKTOP_INNER;
  el.style.cssText = [
    'position: fixed',
    'top: -100px',
    'left: -100px',
    'z-index: 2147483647',
    'pointer-events: none',
    'will-change: left, top, transform, opacity',
    'opacity: 0',
  ].join('; ');

  const ripple = document.createElement('div');
  ripple.id = RIPPLE_ID;
  ripple.style.cssText = [
    'position: fixed',
    'z-index: 2147483646',
    'pointer-events: none',
    'width: 0',
    'height: 0',
    'box-sizing: border-box',
    'border-radius: 50%',
    `border: 2px solid ${CURSOR_COLOR}`,
    // White hairlines either side of the pink ring, so it reads on dark and
    // on pink alike.
    'box-shadow: 0 0 0 1px rgba(255,255,255,0.7), inset 0 0 0 1px rgba(255,255,255,0.7)',
    'opacity: 0',
    'transform: translate(-50%, -50%)',
  ].join('; ');

  document.documentElement.appendChild(ripple);
  document.documentElement.appendChild(el);
  ensureCaptureHideStyle();
  s.el = el;
  s.rippleEl = ripple;

  // A hard navigation destroyed the previous document's cursor mid-run. Pick
  // up where it was — visible, if it was — so the new page's first frame shows
  // the cursor in place instead of re-entering from an edge.
  const saved = readSavedPosition();
  if (saved) {
    s.x = saved.x;
    s.y = saved.y;
    s.hasPosition = true;
    placeAt(el, saved);
    if (saved.visible) {
      el.style.opacity = '1';
      s.visibilityState = 'visible';
    }
  }
}

// The capture hide lives in a <style> rrweb is told to block (`rr-block`): it
// applies to the live page, so screenshots stay clean, but neither the element
// nor its text ever enters the recording — hiding through the cursor's own
// style blinked it off in the replay at every screenshot.
function ensureCaptureHideStyle(): HTMLStyleElement {
  let st = document.getElementById(HIDE_STYLE_ID) as HTMLStyleElement | null;
  if (!st) {
    st = document.createElement('style');
    st.id = HIDE_STYLE_ID;
    st.className = 'rr-block';
    document.documentElement.appendChild(st);
  }
  return st;
}

function setCaptureHidden(hidden: boolean): void {
  const st = ensureCaptureHideStyle();
  const css = hidden
    ? `#${CURSOR_ID}, #${RIPPLE_ID} { opacity: 0 !important; }`
    : '';
  if (st.textContent !== css) {
    st.textContent = css;
  }
}

// Position persistence across hard navigations within a run (sessionStorage is
// per tab). Stale entries are ignored so the cursor never reappears on a page
// the user opens themselves later.
function savePosition(): void {
  const s = getState().cursor;
  if (!s.hasPosition) {
    return;
  }
  try {
    sessionStorage.setItem(
      POSITION_KEY,
      JSON.stringify({
        x: s.x,
        y: s.y,
        visible: isShowing(s.visibilityState),
        ts: Date.now(),
      }),
    );
  } catch {
    // Storage unavailable — the next document enters from an edge, as before.
  }
}

function readSavedPosition(): {
  x: number;
  y: number;
  visible: boolean;
} | null {
  try {
    const raw = sessionStorage.getItem(POSITION_KEY);
    if (!raw) {
      return null;
    }
    const v = JSON.parse(raw);
    if (
      typeof v?.x !== 'number' ||
      typeof v?.y !== 'number' ||
      Date.now() - (typeof v.ts === 'number' ? v.ts : 0) > POSITION_MAX_AGE_MS
    ) {
      return null;
    }
    return { x: v.x, y: v.y, visible: !!v.visible };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Travel and follow
//
// Two distinct jobs, deliberately separated: `animateTo` is the travel that
// callers await, and it always ends on a clock. `follow` is pure cosmetics after
// arrival — keeping the cursor glued to a target that scrolls or reflows — and
// nothing ever waits on it. `stopTracking` cancels whichever is running.
// ---------------------------------------------------------------------------

function stopTracking(): void {
  const s = getState().cursor;
  if (s.trackingFrame !== null) {
    cancelAnimationFrame(s.trackingFrame);
    s.trackingFrame = null;
  }
  if (s.moveTimer !== null) {
    clearTimeout(s.moveTimer);
    s.moveTimer = null;
  }
  s.targetElement = null;
}

/** Where the tip lands on `element` (see Anchor), clamped inside the viewport. */
function targetPoint(
  element: Element,
  anchor: Anchor,
): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const x =
    anchor === 'text'
      ? rect.left + Math.min(Math.max(rect.width * 0.3, 16), rect.width / 2)
      : rect.left + rect.width / 2;
  return {
    x: Math.max(EDGE_BUFFER, Math.min(x, window.innerWidth - EDGE_BUFFER)),
    y: Math.max(
      EDGE_BUFFER,
      Math.min(rect.top + rect.height / 2, window.innerHeight - EDGE_BUFFER),
    ),
  };
}

/** Put the cursor at `to` with no travel (entry, and follow's shifts). */
function placeAt(el: HTMLElement, to: { x: number; y: number }): void {
  el.style.transition = 'none';
  el.style.left = `${to.x}px`;
  el.style.top = `${to.y}px`;
}

/** Glide the cursor to `to` over `ms`: one style write, interpolated by the browser. */
function glide(
  el: HTMLElement,
  to: { x: number; y: number },
  ms: number,
): void {
  el.style.transition = `left ${ms}ms ${MOVE_EASING}, top ${ms}ms ${MOVE_EASING}`;
  el.style.left = `${to.x}px`;
  el.style.top = `${to.y}px`;
}

/** Release whoever is awaiting the current move, if anyone. */
function resolveMove(): void {
  const s = getState().cursor;
  if (s.settledResolve) {
    const resolve = s.settledResolve;
    s.settledResolve = null;
    resolve();
  }
}

/**
 * Glide the cursor to `element` on a distance-scaled clock (MOVE_*), then
 * resolve the pending move. The clock, not the transition, decides when the
 * move is over, so it always completes on time; a layout shift under the
 * target during the glide is closed with one short correction hop.
 */
function animateTo(element: Element, anchor: Anchor): void {
  const s = getState().cursor;
  if (!s.el) {
    resolveMove();
    return;
  }
  const to = targetPoint(element, anchor);
  const distance = Math.hypot(to.x - s.x, to.y - s.y);
  const duration = Math.min(
    MOVE_MAX_MS,
    Math.max(MOVE_MIN_MS, MOVE_BASE_MS + distance * MOVE_MS_PER_PX),
  );
  glide(s.el, to, duration);
  s.x = to.x;
  s.y = to.y;

  s.moveTimer = setTimeout(() => {
    s.moveTimer = null;
    if (s.el && element.isConnected) {
      const now = targetPoint(element, anchor);
      if (Math.hypot(now.x - s.x, now.y - s.y) > 1) {
        glide(s.el, now, CORRECTION_MS);
        s.x = now.x;
        s.y = now.y;
      }
    }
    savePosition();
    resolveMove();
    if (element.isConnected) {
      follow(element, anchor);
    }
  }, duration);
}

/**
 * Keep the cursor on `element` after arrival. Cosmetic; nothing awaits it.
 * Writes only when the target actually shifts: every write is a recorded
 * mutation, and a resting cursor should record nothing.
 */
function follow(element: Element, anchor: Anchor): void {
  const s = getState().cursor;

  const tick = () => {
    if (!s.el || s.targetElement !== element || !element.isConnected) {
      s.trackingFrame = null;
      return;
    }
    const to = targetPoint(element, anchor);
    if (Math.abs(to.x - s.x) > 0.5 || Math.abs(to.y - s.y) > 0.5) {
      placeAt(s.el, to);
      s.x = to.x;
      s.y = to.y;
    }
    s.trackingFrame = requestAnimationFrame(tick);
  };

  s.trackingFrame = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------

export async function moveTo(
  element: Element,
  opts: { anchor?: Anchor } = {},
): Promise<void> {
  const s = getState().cursor;
  const anchor = opts.anchor ?? 'center';

  // Create (or re-create) if missing or detached by navigation/HMR.
  // Self-heals when initCursor() didn't run (e.g. page loaded without the
  // iframe signal) or when the DOM was torn down.
  if (!s.el || !s.el.isConnected) {
    s.el = null;
    s.rippleEl = null;
    s.hasPosition = false;
    createCursorElements();
  }

  if (!s.el) {
    return;
  }

  clearHideTimer();

  // Cancel whatever loop is running and release any superseded caller before
  // taking over the target.
  stopTracking();
  resolveMove();

  s.targetElement = element;

  if (!s.hasPosition) {
    // First time — enter from a random edge near the element
    const rect = element.getBoundingClientRect();
    const elemX = rect.left + rect.width / 2;
    const elemY = rect.top + rect.height / 2;
    const vw = Math.max(window.innerWidth, 100);
    const vh = Math.max(window.innerHeight, 100);
    if (Math.random() < 0.5) {
      s.x = vw + 20;
      s.y = elemY + (Math.random() - 0.5) * 100;
    } else {
      s.x = elemX + (Math.random() - 0.5) * 100;
      s.y = vh + 20;
    }
    placeAt(s.el, { x: s.x, y: s.y });
    s.el.style.opacity = '0';
    s.el.offsetWidth;
    s.hasPosition = true;
  }

  // Visible at once, no fade: the glide below transitions left/top only, and
  // its first frame should already show the cursor.
  if (s.el.style.opacity !== '1') {
    s.el.style.opacity = '1';
  }
  s.visibilityState = 'visible';
  // The tag steps back while the cursor is parked on a field being typed into.
  setTagDimmed(anchor === 'text');

  return new Promise<void>((resolve) => {
    s.settledResolve = resolve;
    animateTo(element, anchor);
  });
}

function cursorBody(): HTMLElement | null {
  return (
    getState().cursor.el?.querySelector<HTMLElement>('[data-cursor-body]') ??
    null
  );
}

function setTagDimmed(dimmed: boolean): void {
  const tag =
    getState().cursor.el?.querySelector<HTMLElement>('[data-cursor-tag]');
  if (tag) {
    tag.style.opacity = dimmed ? '0.7' : '1';
  }
}

// ---------------------------------------------------------------------------
// Click effect
// ---------------------------------------------------------------------------

/**
 * Press: the arrow squashes toward its tip and a ring ripples out from it.
 * Resolves at the bottom of the press — the moment to dispatch the real click,
 * so the app's reaction lands with the ripple instead of a beat after it.
 */
export async function press(): Promise<void> {
  const s = getState().cursor;
  if (!s.el) {
    return;
  }

  const body = cursorBody();
  if (body) {
    body.style.transition = `transform ${PRESS_MS}ms cubic-bezier(0.4, 0, 1, 1)`;
    body.style.transform = 'scale(0.88)';
  }

  if (s.rippleEl) {
    s.rippleEl.style.transition = 'none';
    s.rippleEl.style.left = `${s.x}px`;
    s.rippleEl.style.top = `${s.y}px`;
    s.rippleEl.style.width = '0';
    s.rippleEl.style.height = '0';
    s.rippleEl.style.opacity = '0.8';
    s.rippleEl.offsetWidth;

    // The ring grows fast and fades late: it holds while the press lands,
    // then dissolves as it reaches full size.
    const grow = `${RIPPLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
    s.rippleEl.style.transition = `width ${grow}, height ${grow}, opacity ${RIPPLE_MS}ms cubic-bezier(0.6, 0, 0.9, 0.5)`;
    s.rippleEl.style.width = `${RIPPLE_SIZE}px`;
    s.rippleEl.style.height = `${RIPPLE_SIZE}px`;
    s.rippleEl.style.opacity = '0';
  }

  await sleep(PRESS_MS);
}

/** Release: the arrow springs back. Cosmetic; nothing needs to await it. */
export function release(): void {
  const body = cursorBody();
  if (!body) {
    return;
  }
  body.style.transition = `transform ${RELEASE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
  body.style.transform = 'scale(1)';
}

// ---------------------------------------------------------------------------
// Visibility state machine
//
// Single source of truth: s.visibilityState
// Single place opacity is written: applyVisibility()
// ---------------------------------------------------------------------------

type VisState = typeof getState extends () => {
  cursor: { visibilityState: infer V };
}
  ? V
  : never;

/** Returns true if the cursor is currently showing (or should be treated as showing). */
function isShowing(vs: VisState): boolean {
  return (
    vs === 'visible' ||
    vs === 'fading-in' ||
    vs === 'fading-out' ||
    vs === 'force-visible'
  );
}

/**
 * The ONLY function that writes s.el.style.opacity.
 * All visibility changes go through here to prevent desync.
 */
function applyVisibility(newState: VisState): void {
  const s = getState().cursor;
  s.visibilityState = newState;

  if (!s.el || !s.el.isConnected) {
    return;
  }

  // A capture hides through the recorder-blind stylesheet, never through the
  // element (see setCaptureHidden); leaving that state clears it.
  setCaptureHidden(newState === 'snapshot-hidden');

  switch (newState) {
    case 'snapshot-hidden':
      break;

    case 'hidden':
    case 'force-hidden':
      s.el.style.transition = 'none';
      s.el.style.opacity = '0';
      if (s.rippleEl) {
        s.rippleEl.style.opacity = '0';
      }
      break;

    case 'fading-in':
      s.el.style.transition = `opacity ${FADE_DURATION}ms ease`;
      s.el.offsetWidth; // force reflow
      s.el.style.opacity = '1';
      break;

    case 'visible':
    case 'force-visible':
      // Guarded: a redundant write would still be a recorded mutation.
      if (s.el.style.opacity !== '1') {
        s.el.style.opacity = '1';
      }
      break;

    case 'fading-out':
      s.el.style.transition = `opacity ${FADE_DURATION}ms ease`;
      s.el.style.opacity = '0';
      break;
  }
}

function clearHideTimer(): void {
  const s = getState().cursor;
  if (s.hideTimer) {
    clearTimeout(s.hideTimer);
    s.hideTimer = null;
  }
}

export function setExecuting(value: boolean): void {
  getState().cursor.executing = value;
  if (value) {
    hideCircle();
  } else {
    showCircle();
  }
}

export function cancelHide(): void {
  clearHideTimer();
}

export function scheduleHide(): void {
  const s = getState().cursor;
  if (!s.el) {
    return;
  }
  if (s.visibilityState === 'force-visible') {
    return;
  }

  s.targetElement = null;

  clearHideTimer();
  // Keep state as-is during the delay — cursor stays visible.
  // Only transition to fading-out when the timer fires.
  s.hideTimer = setTimeout(() => {
    if (s.visibilityState === 'force-visible') {
      return;
    }
    applyVisibility('fading-out');
    // After the CSS fade completes, fully hide
    s.hideTimer = setTimeout(() => {
      if (s.visibilityState === 'fading-out') {
        applyVisibility('hidden');
        stopTracking();
      }
      s.hideTimer = null;
    }, FADE_DURATION);
  }, HIDE_DELAY);
}

/**
 * Freeze the cursor in place, visible, with no pending fade-out. Used between
 * commands while a session recording is active: the recorder runs continuously
 * across commands, so a fade-out/fade-in at every command seam would show up as
 * the cursor blinking in the stitched replay. Holding keeps it as a steady
 * resting cursor; the next moveTo() resumes tracking and animates to the new
 * target.
 */
export function hold(): void {
  const s = getState().cursor;
  if (!s.el) {
    return;
  }
  clearHideTimer();
  stopTracking();
  // Re-assert visible unless something deliberately hid it (forced hide or a
  // mid-screenshot snapshot hide) — don't override those.
  if (
    s.visibilityState !== 'force-hidden' &&
    s.visibilityState !== 'snapshot-hidden'
  ) {
    // transition:none so the opacity stays put instantly and can't inherit a
    // mid-flight fade transition.
    if (s.el.isConnected) {
      s.el.style.transition = 'none';
    }
    applyVisibility('visible');
  }
  savePosition();
}

/** Instantly hide the cursor element (no fade). Used during screenshots. */
export function hide(): void {
  const s = getState().cursor;
  // No-op if already snapshot-hidden — prevents double-hide from destroying restore state
  if (s.visibilityState === 'snapshot-hidden') {
    return;
  }
  clearHideTimer();
  s.preSnapshotState = s.visibilityState;
  applyVisibility('snapshot-hidden');
}

/** Restore cursor visibility after a hide() call. Restores if it was visible. */
export function restore(): void {
  const s = getState().cursor;
  const prev = s.preSnapshotState;
  s.preSnapshotState = null;
  if (!s.el || !prev || !isShowing(prev)) {
    return;
  }
  applyVisibility(prev === 'fading-in' ? 'fading-in' : 'visible');
}

/** Switch between desktop arrow and mobile touch circle. */
export function setMobileStyle(mobile: boolean): void {
  const s = getState().cursor;
  if (!s.el) {
    return;
  }
  s.el.innerHTML = mobile ? MOBILE_INNER : DESKTOP_INNER;
}

export function setForcedVisibility(state: 'visible' | 'hidden' | null): void {
  const s = getState().cursor;
  if (s.executing) {
    return;
  }

  if (state === 'visible' && !s.el) {
    createCursorElements();
  }

  if (!s.el) {
    return;
  }

  if (state === 'visible') {
    clearHideTimer();
    if (s.hasPosition) {
      applyVisibility('force-visible');
    } else {
      // Stay invisible until moveTo() provides a position, but mark intent
      s.visibilityState = 'force-visible';
    }
  } else if (state === 'hidden') {
    clearHideTimer();
    applyVisibility('force-hidden');
    stopTracking();
  } else {
    scheduleHide();
  }
}
