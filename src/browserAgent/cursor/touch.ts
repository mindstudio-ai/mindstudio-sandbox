/**
 * Mobile preview touch simulation.
 *
 * When the preview is in mobile mode, hides the native cursor and shows
 * a translucent touch circle that follows the mouse. Click-and-drag
 * scrolls the page (like a finger on a phone screen).
 *
 * Short clicks (< 5px movement) pass through as normal clicks.
 * Only active in iframe mode with preview=mobile.
 */

import { getState } from '../state';
import { findScrollContainer } from '../utils';

const CIRCLE_ID = '__mindstudio-touch-circle';
const STYLE_ID = '__mindstudio-touch-style';
const CIRCLE_SIZE = 44;
const DRAG_THRESHOLD = 5;
const MOMENTUM_FRICTION = 0.95;
const MOMENTUM_MIN_VELOCITY = 0.5;
const OVERSCROLL_RESISTANCE = 0.45;
const BOUNCE_DURATION = 600;

// ---------------------------------------------------------------------------
// Circle element
// ---------------------------------------------------------------------------

function createCircle(): HTMLDivElement {
  document.getElementById(CIRCLE_ID)?.remove();

  const el = document.createElement('div');
  el.id = CIRCLE_ID;
  el.style.cssText = [
    'position: fixed',
    'z-index: 2147483647',
    'pointer-events: none',
    `width: ${CIRCLE_SIZE}px`,
    `height: ${CIRCLE_SIZE}px`,
    'border-radius: 50%',
    'background: rgba(255, 255, 255, 0.08)',
    'border: 2px solid rgba(255, 255, 255, 0.85)',
    'box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), inset 0 0 0 0.5px rgba(0, 0, 0, 0.1)',
    'backdrop-filter: blur(1px)',
    '-webkit-backdrop-filter: blur(1.5px)',
    'transform: translate(-50%, -50%) scale(1)',
    'transition: transform 100ms ease, opacity 100ms ease, background 100ms ease',
    'opacity: 0',
    'will-change: left, top, transform, opacity',
  ].join('; ');

  document.documentElement.appendChild(el);
  return el;
}

function showPressed(el: HTMLDivElement): void {
  el.style.transform = 'translate(-50%, -50%) scale(0.88)';
  el.style.background = 'rgba(255, 255, 255, 0.18)';
}

function showReleased(el: HTMLDivElement): void {
  el.style.transform = 'translate(-50%, -50%) scale(1)';
  el.style.background = 'rgba(255, 255, 255, 0.08)';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize touch simulation. Reads initial mobile preview state
 * and activates if already in mobile mode.
 */
export function initTouch(): void {
  if (window.parent === window) {
    return;
  }
  if (getState().zoom.mobilePreview) {
    activateTouch();
  }
}

/**
 * Enable touch simulation — hide native cursor, show touch circle,
 * enable click-to-drag scroll.
 */
export function activateTouch(): void {
  const t = getState().touch;
  if (t.active) {
    return;
  }
  t.active = true;

  t.scrollContainer = findScrollContainer();

  injectStyle();

  const circle = createCircle();
  t.circleEl = circle;

  t.onMouseMove = (e: MouseEvent) => {
    // Hide during Remy execution or screenshot
    const s = getState();
    if (s.cursor.executing || s.screenshot.capturing) {
      circle.style.opacity = '0';
      return;
    }

    circle.style.left = `${e.clientX}px`;
    circle.style.top = `${e.clientY}px`;
    circle.style.opacity = '1';

    // Drag scroll
    if (t.pressed) {
      const dx = Math.abs(e.clientX - t.startX);
      const dy = Math.abs(e.clientY - t.startY);

      if (!t.dragging && (dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD)) {
        t.dragging = true;
      }

      if (t.dragging) {
        const sc = t.scrollContainer || document.documentElement;
        const now = performance.now();
        const dt = now - t.lastMoveTime || 16;
        const dx2 = t.lastX - e.clientX;
        const dy2 = t.lastY - e.clientY;

        if (t.bouncing) {
          cancelBounce();
        }

        const scrollBefore = sc.scrollTop;
        sc.scrollTop += dy2;
        sc.scrollLeft += dx2;
        const scrollAfter = sc.scrollTop;
        const consumed = scrollAfter - scrollBefore;
        const unconsumed = dy2 - consumed;

        // If scroll didn't consume the full delta, we're at a boundary
        if (Math.abs(unconsumed) > 0.5) {
          // Diminishing resistance — the further you pull, the harder it gets
          const resistance =
            OVERSCROLL_RESISTANCE / (1 + Math.abs(t.overscrollY) / 200);
          t.overscrollY += unconsumed * resistance;
          applyOverscroll();
        } else if (t.overscrollY !== 0) {
          // Dragging back from overscroll toward content
          const resistance =
            OVERSCROLL_RESISTANCE / (1 + Math.abs(t.overscrollY) / 200);
          t.overscrollY += unconsumed * resistance;
          if (
            (t.overscrollY > 0 && dy2 < 0) ||
            (t.overscrollY < 0 && dy2 > 0)
          ) {
            t.overscrollY *= 0.7;
          }
          applyOverscroll();
        }

        // Track velocity (px/ms) with smoothing
        t.velocityX = 0.8 * (dx2 / dt) + 0.2 * t.velocityX;
        t.velocityY = 0.8 * (dy2 / dt) + 0.2 * t.velocityY;
        t.lastMoveTime = now;

        e.preventDefault();
      }

      t.lastX = e.clientX;
      t.lastY = e.clientY;
    }
  };

  t.onMouseDown = (e: MouseEvent) => {
    // Ignore during Remy execution
    if (getState().cursor.executing) {
      return;
    }

    stopMomentum();

    t.pressed = true;
    t.dragging = false;
    t.startX = e.clientX;
    t.startY = e.clientY;
    t.lastX = e.clientX;
    t.lastY = e.clientY;
    t.velocityX = 0;
    t.velocityY = 0;
    t.lastMoveTime = performance.now();

    showPressed(circle);
  };

  t.onMouseUp = () => {
    const wasDragging = t.dragging;

    if (wasDragging) {
      // Suppress the click that follows a drag
      document.addEventListener('click', suppressClick, {
        capture: true,
        once: true,
      });
    }

    t.pressed = false;
    t.dragging = false;
    showReleased(circle);

    if (wasDragging) {
      if (t.overscrollY !== 0) {
        bounceBack();
      }
      // Kick off momentum scroll if there was meaningful velocity
      if (
        Math.abs(t.velocityX) > MOMENTUM_MIN_VELOCITY / 16 ||
        Math.abs(t.velocityY) > MOMENTUM_MIN_VELOCITY / 16
      ) {
        startMomentum();
      }
    }
  };

  t.onMouseLeave = () => {
    t.pressed = false;
    t.dragging = false;
    stopMomentum();
    circle.style.opacity = '0';
    showReleased(circle);
  };

  t.onDragStart = (e: Event) => e.preventDefault();

  document.addEventListener('mousemove', t.onMouseMove);
  document.addEventListener('mousedown', t.onMouseDown);
  document.addEventListener('mouseup', t.onMouseUp);
  document.addEventListener('mouseleave', t.onMouseLeave);
  document.addEventListener('dragstart', t.onDragStart);
}

/**
 * Disable touch simulation — restore native cursor.
 */
export function deactivateTouch(): void {
  const t = getState().touch;
  if (!t.active) {
    return;
  }
  t.active = false;
  t.pressed = false;
  t.dragging = false;
  stopMomentum();
  if (t.overscrollY !== 0) {
    t.overscrollY = 0;
    document.body.style.transition = '';
    document.body.style.transform = '';
  }

  removeStyle();

  if (t.circleEl) {
    t.circleEl.remove();
    t.circleEl = null;
  }

  if (t.onMouseMove) {
    document.removeEventListener('mousemove', t.onMouseMove);
  }
  if (t.onMouseDown) {
    document.removeEventListener('mousedown', t.onMouseDown);
  }
  if (t.onMouseUp) {
    document.removeEventListener('mouseup', t.onMouseUp);
  }
  if (t.onMouseLeave) {
    document.removeEventListener('mouseleave', t.onMouseLeave);
  }
  if (t.onDragStart) {
    document.removeEventListener('dragstart', t.onDragStart);
  }
  t.onMouseMove = null;
  t.onMouseDown = null;
  t.onMouseUp = null;
  t.onMouseLeave = null;
  t.onDragStart = null;
}

/** Hide the touch circle (e.g. during screenshots). */
export function hideCircle(): void {
  const { circleEl } = getState().touch;
  if (circleEl) {
    circleEl.style.opacity = '0';
  }
}

/** Show the touch circle if touch sim is active. */
export function showCircle(): void {
  const t = getState().touch;
  if (t.active && t.circleEl) {
    t.circleEl.style.opacity = '1';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function suppressClick(e: Event): void {
  e.preventDefault();
  e.stopPropagation();
}

// ---------------------------------------------------------------------------
// Momentum scroll
// ---------------------------------------------------------------------------

function startMomentum(): void {
  stopMomentum();

  const t = getState().touch;
  const sc = t.scrollContainer || document.documentElement;

  // Convert velocity from px/ms to px/frame (assuming ~16ms frames)
  let vx = t.velocityX * 16;
  let vy = t.velocityY * 16;

  function tick() {
    const t = getState().touch;
    vx *= MOMENTUM_FRICTION;
    vy *= MOMENTUM_FRICTION;

    if (
      Math.abs(vx) < MOMENTUM_MIN_VELOCITY &&
      Math.abs(vy) < MOMENTUM_MIN_VELOCITY
    ) {
      t.momentumFrame = null;
      if (t.overscrollY !== 0) {
        bounceBack();
      }
      return;
    }

    const scrollBefore = sc.scrollTop;
    sc.scrollTop += vy;
    sc.scrollLeft += vx;
    const consumed = sc.scrollTop - scrollBefore;
    const unconsumed = vy - consumed;

    // Hit boundary during momentum — overscroll and decelerate faster
    if (Math.abs(unconsumed) > 0.5) {
      const resistance =
        (OVERSCROLL_RESISTANCE * 0.5) / (1 + Math.abs(t.overscrollY) / 200);
      t.overscrollY += unconsumed * resistance;
      applyOverscroll();
      vy *= 0.7;
    }

    t.momentumFrame = requestAnimationFrame(tick);
  }

  t.momentumFrame = requestAnimationFrame(tick);
}

function stopMomentum(): void {
  const t = getState().touch;
  if (t.momentumFrame !== null) {
    cancelAnimationFrame(t.momentumFrame);
    t.momentumFrame = null;
  }
}

// ---------------------------------------------------------------------------
// Overscroll bounce
// ---------------------------------------------------------------------------

function applyOverscroll(): void {
  const t = getState().touch;
  document.body.style.transition = 'none';
  document.body.style.transform = `translateY(${-t.overscrollY}px)`;
}

function bounceBack(): void {
  const t = getState().touch;
  t.bouncing = true;
  t.overscrollY = 0;
  document.body.style.transition = `transform ${BOUNCE_DURATION}ms cubic-bezier(0.2, 0.9, 0.3, 1)`;
  document.body.style.transform = '';
  if (t.bounceTimer) {
    clearTimeout(t.bounceTimer);
  }
  t.bounceTimer = setTimeout(() => {
    const t = getState().touch;
    t.bouncing = false;
    t.bounceTimer = null;
    document.body.style.transition = '';
    document.body.style.transform = '';
  }, BOUNCE_DURATION);
}

function cancelBounce(): void {
  const t = getState().touch;
  if (t.bouncing) {
    t.bouncing = false;
    if (t.bounceTimer) {
      clearTimeout(t.bounceTimer);
      t.bounceTimer = null;
    }
    document.body.style.transition = '';
  }
}

function injectStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    *, *::before, *::after {
      cursor: none !important;
      user-select: none !important;
      -webkit-user-select: none !important;
      -webkit-user-drag: none !important;
    }
  `;
  document.head.appendChild(style);
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}
