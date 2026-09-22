/**
 * Command executor — dispatches command steps to handlers.
 * Executes steps sequentially. Stops on first error.
 * Cursor animation happens before each action so the user sees
 * the cursor move to the target before interacting.
 */

import { takeSnapshot, getRefMap } from '../snapshot/walker';
import { resolveElement } from './resolve';
import * as actions from './actions';
import * as cursor from '../cursor/cursor';
import { startCapture, stopCapture } from '../transport';
import type {
  BrowserStep,
  CommandResult,
  LogEntry,
  StepResult,
} from '../protocol';
import {
  ensureSessionRecorder,
  flushSessionRecording,
  isRecording,
  markStep,
} from '../recording/session-recorder';

import { sleep, findScrollContainer } from '../utils';

const DEFAULT_STYLE_PROPERTIES = [
  'backgroundColor',
  'color',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textDecoration',
  'textTransform',
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'borderRadius',
  'borderColor',
  'borderWidth',
  'borderStyle',
  'boxShadow',
  'opacity',
  'width',
  'height',
  'display',
  'flexDirection',
  'justifyContent',
  'alignItems',
  'gap',
];

/**
 * Get computed styles for element(s).
 * If the step targets a specific element (ref/text/selector), returns styles for that element.
 * If no target, returns styles for all ref'd elements from the last snapshot.
 */
function getStyles(
  step: Record<string, unknown>,
  properties?: string[],
): Record<string, unknown> | Array<Record<string, unknown>> {
  const props = properties ?? DEFAULT_STYLE_PROPERTIES;

  // Targeted: single element
  if (step.ref || step.text || step.role || step.label || step.selector) {
    const { element, matched } = resolveElement(step);
    return { ...readStyles(element, step.ref as string, props), matched };
  }

  // No target: all ref'd elements from last snapshot
  const refMap = getRefMap();
  const results: Array<Record<string, unknown>> = [];
  for (const [ref, element] of refMap) {
    if (!element.isConnected) {
      continue;
    }
    results.push(readStyles(element, ref, props));
  }
  return results;
}

function readStyles(
  element: Element,
  ref: string | undefined,
  properties: string[],
): Record<string, unknown> {
  const computed = window.getComputedStyle(element);
  const styles: Record<string, unknown> = {};
  if (ref) {
    styles.ref = ref;
  }
  styles.tag = element.tagName.toLowerCase();

  const text = element.textContent?.trim();
  if (text) {
    styles.text = text.length > 60 ? text.slice(0, 60) + '…' : text;
  }

  for (const prop of properties) {
    const value = computed.getPropertyValue(
      // Convert camelCase to kebab-case for getPropertyValue
      prop.replace(/([A-Z])/g, '-$1').toLowerCase(),
    );
    if (value) {
      styles[prop] = value;
    }
  }

  return styles;
}

const STEP_PAUSE_BASE = 25;
const STEP_PAUSE_JITTER = 25; // +/-12.5ms — just enough for debounce
const PENDING_NAV_KEY = '__mindstudio_pending_nav';
const NAV_SETTLE_MS = 300;
const NAV_TIMEOUT_MS = 10_000;

/**
 * Navigate within the SPA using history.pushState + popstate. This avoids a
 * full page reload so the WebSocket stays alive and remaining batch steps
 * can execute normally. Falls back to window.location.href for cross-origin
 * URLs (which will trigger the stash/resume path).
 *
 * Returns true if navigation was handled as SPA (no reload), false if it
 * required a hard navigation.
 */
/**
 * Returns true if the browser is already on the given URL (same path,
 * search, and hash), so we can skip navigation entirely.
 */
function isAlreadyOnPage(url: string): boolean {
  try {
    const resolved = new URL(url, window.location.origin);
    if (resolved.origin !== window.location.origin) {
      return false;
    }
    return (
      resolved.pathname === window.location.pathname &&
      resolved.search === window.location.search &&
      resolved.hash === window.location.hash
    );
  } catch {
    return false;
  }
}

function spaNavigate(url: string): boolean {
  try {
    const resolved = new URL(url, window.location.origin);
    if (resolved.origin !== window.location.origin) {
      return false;
    }
    if (isAlreadyOnPage(url)) {
      return true; // no-op, already there
    }
    window.history.pushState(
      null,
      '',
      resolved.pathname + resolved.search + resolved.hash,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the page to settle after an action — scroll, layout shifts,
 * animations, DOM changes (dialogs appearing, forms expanding, etc).
 * Monitors scroll positions and body dimensions. Resolves once everything
 * has been stable for the settle period.
 */
async function waitForActionSettle(
  settleMs = 300,
  timeoutMs = 2000,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let stableStart = Date.now();

    // Also monitor the primary scroll container for nested-scroll apps
    const container = findScrollContainer();

    let lastScrollY = window.scrollY;
    let lastScrollX = window.scrollX;
    let lastBodyScrollTop = document.body.scrollTop;
    let lastDocScrollTop = document.documentElement.scrollTop;
    let lastBodyHeight = document.body.scrollHeight;
    let lastBodyWidth = document.body.scrollWidth;
    let lastContainerTop = container.scrollTop;
    let lastContainerLeft = container.scrollLeft;

    function check() {
      if (Date.now() > deadline) {
        resolve();
        return;
      }

      const sy = window.scrollY;
      const sx = window.scrollX;
      const bst = document.body.scrollTop;
      const dst = document.documentElement.scrollTop;
      const bh = document.body.scrollHeight;
      const bw = document.body.scrollWidth;
      const ct = container.scrollTop;
      const cl = container.scrollLeft;

      if (
        sy !== lastScrollY ||
        sx !== lastScrollX ||
        bst !== lastBodyScrollTop ||
        dst !== lastDocScrollTop ||
        bh !== lastBodyHeight ||
        bw !== lastBodyWidth ||
        ct !== lastContainerTop ||
        cl !== lastContainerLeft
      ) {
        lastScrollY = sy;
        lastScrollX = sx;
        lastBodyScrollTop = bst;
        lastDocScrollTop = dst;
        lastBodyHeight = bh;
        lastBodyWidth = bw;
        lastContainerTop = ct;
        lastContainerLeft = cl;
        stableStart = Date.now();
      }

      if (Date.now() - stableStart >= settleMs) {
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    }

    requestAnimationFrame(check);
  });
}

const SCROLL_DURATION = 150; // ms — smooth but snappy

/**
 * Smoothly scroll an element to the center of the viewport.
 * Uses a manual rAF loop with easeOutCubic for predictable timing,
 * since `scrollIntoView({ behavior: 'smooth' })` has inconsistent
 * duration and completion detection across browsers.
 *
 * Handles both document scroll and nested scrollable containers
 * by first using instant `scrollIntoView` to compute the target
 * scroll positions, then animating from original to target.
 */
async function scrollAndSettle(element: Element): Promise<void> {
  // Collect all scrollable ancestors so we can animate them
  const scrollers = getScrollableAncestors(element);

  // Record current scroll positions
  const before = scrollers.map((s) => ({
    el: s,
    top: s.scrollTop,
    left: s.scrollLeft,
  }));

  // Override scroll-behavior: smooth on html — we need a truly instant
  // scrollIntoView to compute target positions, then animate ourselves.
  const prevScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';

  element.scrollIntoView({
    block: 'center',
    inline: 'nearest',
    behavior: 'instant' as ScrollBehavior,
  });

  document.documentElement.style.scrollBehavior = prevScrollBehavior;

  // Record target scroll positions
  const after = scrollers.map((s) => ({
    top: s.scrollTop,
    left: s.scrollLeft,
  }));

  // Find which scrollers actually moved
  const deltas: Array<{
    el: Element;
    fromTop: number;
    fromLeft: number;
    toTop: number;
    toLeft: number;
  }> = [];
  for (let i = 0; i < scrollers.length; i++) {
    if (before[i].top !== after[i].top || before[i].left !== after[i].left) {
      deltas.push({
        el: scrollers[i],
        fromTop: before[i].top,
        fromLeft: before[i].left,
        toTop: after[i].top,
        toLeft: after[i].left,
      });
    }
  }

  // If nothing moved, just settle layout
  if (deltas.length === 0) {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return;
  }

  // Reset to original positions, then animate
  for (const d of deltas) {
    d.el.scrollTop = d.fromTop;
    d.el.scrollLeft = d.fromLeft;
  }

  await new Promise<void>((resolve) => {
    const start = performance.now();

    function tick(now: number) {
      const elapsed = now - start;
      const t = Math.min(elapsed / SCROLL_DURATION, 1);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

      for (const d of deltas) {
        d.el.scrollTop = d.fromTop + (d.toTop - d.fromTop) * ease;
        d.el.scrollLeft = d.fromLeft + (d.toLeft - d.fromLeft) * ease;
      }

      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }

    requestAnimationFrame(tick);
  });
}

/**
 * Walk up the DOM to find all scrollable ancestors (including the document).
 */
function getScrollableAncestors(element: Element): Element[] {
  const scrollers: Element[] = [];
  let current = element.parentElement;

  while (current) {
    const style = getComputedStyle(current);
    const overflowY = style.overflowY;
    const overflowX = style.overflowX;
    if (
      overflowY === 'auto' ||
      overflowY === 'scroll' ||
      overflowX === 'auto' ||
      overflowX === 'scroll'
    ) {
      scrollers.push(current);
    }
    current = current.parentElement;
  }

  // Always include the root scrolling element
  scrollers.push(document.scrollingElement || document.documentElement);
  return scrollers;
}

// Commands that produce a replay-worthy session. Read-only commands
// (snapshot, styles, evaluate, wait), screenshots, and nav/state-only
// batches aren't worth recording — the final screenshot or snapshot
// tells the same story without the overhead.
const RECORDED_COMMANDS = new Set(['click', 'type', 'select']);

function shouldRecord(steps: BrowserStep[]): boolean {
  return steps.some((s) => RECORDED_COMMANDS.has(s.command));
}

export async function executeSteps(
  id: string,
  steps: BrowserStep[],
): Promise<CommandResult> {
  const startTime = Date.now();
  const results: StepResult[] = [];
  let logs: LogEntry[] = [];
  let snapshot = '';
  let navigated = false;

  // Only lock cursor control when the batch contains interactive commands
  // (click, type, select). Snapshot/evaluate/wait batches shouldn't
  // interfere with the cursor's hide timer.
  const CURSOR_COMMANDS = new Set(['click', 'type', 'select']);
  const needsCursor = steps.some((s) => CURSOR_COMMANDS.has(s.command));
  if (needsCursor) {
    cursor.setExecuting(true);
    cursor.cancelHide();
  }
  startCapture();

  // Start the continuous session recorder on the first interactive batch.
  // It stays alive across commands so the rrweb node-ID namespace is
  // continuous; each command's result carries only the events buffered since
  // the previous flush (see recording/session-recorder.ts).
  if (shouldRecord(steps)) {
    ensureSessionRecorder();
  }

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const command = step.command as string;
      markStep(command, i);

      try {
        if (i > 0) {
          await sleep(
            STEP_PAUSE_BASE +
              Math.random() * STEP_PAUSE_JITTER -
              STEP_PAUSE_JITTER / 2,
          );
        }

        // DEPRECATED path (navigate/reload + stash/resume): tunnels with
        // tunnel-side navigation (2026-08+) execute `navigate` via CDP and
        // never send it in a WS batch (`reload` was never produced by
        // anything). Kept only for older tunnels — this script ships to every
        // tunnel version via the proxy injection. Delete once the tunnel
        // fleet has moved.
        if (command === 'navigate') {
          const url = step.url as string;
          if (!url) {
            throw new Error('navigate command requires a "url" field');
          }

          // Try SPA navigation first — keeps the WS alive so remaining
          // steps execute without the stash/resume dance.
          if (spaNavigate(url)) {
            results.push({ index: i, command, result: 'ok' });
            await sleep(NAV_SETTLE_MS);
            continue;
          }

          // Cross-origin: fall back to hard navigation
          const remaining = steps.slice(i + 1);
          if (remaining.length > 0) {
            try {
              sessionStorage.setItem(
                PENDING_NAV_KEY,
                JSON.stringify({
                  id,
                  startTime,
                  completedSteps: results,
                  remainingSteps: remaining,
                  stepOffset: i + 1,
                }),
              );
            } catch {
              // sessionStorage may be unavailable — navigate anyway
            }
          }

          results.push({ index: i, command, result: 'ok' });
          navigated = true;
          window.location.href = url;

          // Wait for the page to actually unload — don't continue executing steps.
          // Timeout prevents hanging forever if navigation fails.
          await new Promise<void>((_, reject) => {
            setTimeout(
              () =>
                reject(new Error('Navigation did not complete within timeout')),
              NAV_TIMEOUT_MS,
            );
          });
        }

        if (command === 'reload') {
          const remaining = steps.slice(i + 1);
          if (remaining.length > 0) {
            try {
              sessionStorage.setItem(
                PENDING_NAV_KEY,
                JSON.stringify({
                  id,
                  startTime,
                  completedSteps: results,
                  remainingSteps: remaining,
                  stepOffset: i + 1,
                }),
              );
            } catch {}
          }
          results.push({ index: i, command, result: 'ok' });
          navigated = true;
          window.location.reload();
          await new Promise<void>((_, reject) => {
            setTimeout(
              () => reject(new Error('Reload did not complete within timeout')),
              NAV_TIMEOUT_MS,
            );
          });
        }

        const result = await executeStep(step);
        results.push({ index: i, command, ...result });
      } catch (err) {
        results.push({
          index: i,
          command,
          error: err instanceof Error ? err.message : String(err),
        });
        // Stop on first error
        break;
      }
    }

    // Always include a final snapshot so the agent sees the page state after actions
    try {
      snapshot = await takeSnapshot();
    } catch {
      // Snapshot failed — return what we have
    }
  } finally {
    logs = stopCapture();
    if (needsCursor) {
      cursor.setExecuting(false);
      // While recording, hold the cursor in place between commands so the
      // continuous replay shows a steady cursor instead of a fade-out/fade-in
      // at every command seam. Otherwise fade out after the idle delay.
      if (isRecording()) {
        cursor.hold();
      } else {
        cursor.scheduleHide();
      }
    }
  }

  // Drain everything the recorder buffered during this batch. The recorder is
  // deliberately left running so the next command continues the same run.
  const recording = flushSessionRecording();
  return {
    id,
    steps: results,
    snapshot,
    logs,
    duration: Date.now() - startTime,
    ...(recording ? { events: recording.events, runId: recording.runId } : {}),
  };
}

/**
 * Peek the command id of a stashed mid-batch navigation without consuming it.
 * Sent in the WS hello so the proxy can tell a command that is about to
 * resume on this page (keep waiting for its result) from one whose in-flight
 * steps died with the previous page (fail it immediately) — e.g. a click that
 * triggered a hard navigation never stashes, so there is nothing to resume.
 */
export function peekPendingNavigationId(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_NAV_KEY);
    if (!raw) {
      return null;
    }
    const pending = JSON.parse(raw) as { id?: unknown };
    return typeof pending?.id === 'string' ? pending.id : null;
  } catch {
    return null;
  }
}

/**
 * Check for and resume a pending navigation command.
 * Called after WS reconnect — if the previous page navigated mid-batch,
 * the remaining steps are stashed in sessionStorage.
 * Returns a CommandResult if there were pending steps, or null.
 *
 * DEPRECATED with the in-batch `navigate` path above: tunnels with
 * tunnel-side navigation (2026-08+) never create a mid-batch page boundary,
 * so nothing new is ever stashed. Kept for older tunnels; delete alongside
 * the navigate/reload branches.
 */
export async function resumePendingNavigation(): Promise<CommandResult | null> {
  let pending: {
    id: string;
    startTime: number;
    completedSteps: StepResult[];
    remainingSteps: BrowserStep[];
    stepOffset: number;
  } | null = null;

  try {
    const raw = sessionStorage.getItem(PENDING_NAV_KEY);
    if (!raw) {
      return null;
    }
    sessionStorage.removeItem(PENDING_NAV_KEY);
    pending = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!pending) {
    return null;
  }

  // Execute the remaining steps on the new page
  const results = [...pending.completedSteps];
  let logs: LogEntry[] = [];
  let snapshot = '';

  const needsCursorResume = pending.remainingSteps.some(
    (s) =>
      s.command === 'click' || s.command === 'type' || s.command === 'select',
  );
  if (needsCursorResume) {
    cursor.setExecuting(true);
    cursor.cancelHide();
    // Resumed steps run on the post-navigation page — a fresh document, so
    // this starts a new run with its own FullSnapshot (a legitimate rebuild
    // seam at the navigation boundary).
    ensureSessionRecorder();
  }
  startCapture();

  try {
    for (let i = 0; i < pending.remainingSteps.length; i++) {
      const step = pending.remainingSteps[i];
      const command = step.command as string;
      const index = pending.stepOffset + i;
      markStep(command, index);

      try {
        if (i > 0) {
          await sleep(
            STEP_PAUSE_BASE +
              Math.random() * STEP_PAUSE_JITTER -
              STEP_PAUSE_JITTER / 2,
          );
        }

        // Support chained navigations
        if (command === 'navigate') {
          const url = step.url as string;
          if (!url) {
            throw new Error('navigate command requires a "url" field');
          }

          if (spaNavigate(url)) {
            results.push({ index, command, result: 'ok' });
            await sleep(NAV_SETTLE_MS);
            continue;
          }

          // Cross-origin: fall back to hard navigation
          const remaining = pending.remainingSteps.slice(i + 1);
          if (remaining.length > 0) {
            try {
              sessionStorage.setItem(
                PENDING_NAV_KEY,
                JSON.stringify({
                  id: pending.id,
                  startTime: pending.startTime,
                  completedSteps: results,
                  remainingSteps: remaining,
                  stepOffset: index + 1,
                }),
              );
            } catch {}
          }

          results.push({ index, command, result: 'ok' });
          window.location.href = url;
          await new Promise<void>((_, reject) => {
            setTimeout(
              () =>
                reject(new Error('Navigation did not complete within timeout')),
              NAV_TIMEOUT_MS,
            );
          });
        }

        const result = await executeStep(step);
        results.push({ index, command, ...result });
      } catch (err) {
        results.push({
          index,
          command,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }

    try {
      snapshot = await takeSnapshot();
    } catch {}
  } finally {
    logs = stopCapture();
    if (needsCursorResume) {
      cursor.setExecuting(false);
      if (isRecording()) {
        cursor.hold();
      } else {
        cursor.scheduleHide();
      }
    }
  }

  const recording = flushSessionRecording();
  return {
    id: pending.id,
    steps: results,
    snapshot,
    logs,
    duration: Date.now() - pending.startTime,
    ...(recording ? { events: recording.events, runId: recording.runId } : {}),
  };
}

async function executeStep(
  step: Record<string, unknown>,
): Promise<{ result?: unknown; matched?: string; elapsed?: number }> {
  switch (step.command) {
    case 'snapshot':
      return { result: await takeSnapshot() };

    case 'click': {
      const { element, matched } = resolveElement(step);
      await scrollAndSettle(element);
      await cursor.moveTo(element);
      // The real click fires at the bottom of the press, so the app reacts in
      // step with the cursor rather than after the whole animation.
      await cursor.press();
      actions.click(element);
      cursor.release();
      await waitForActionSettle();
      await sleep(250); // short dwell so post-click state lands in the rrweb recording
      return { result: 'ok', matched };
    }

    case 'type': {
      const { element, matched } = resolveElement(step);
      const text = step.text as string;
      if (!text && text !== '') {
        throw new Error('type command requires a "text" field');
      }
      await scrollAndSettle(element);
      await cursor.moveTo(element, { anchor: 'text' });
      await actions.type(element, text, { clear: !!step.clear });
      await waitForActionSettle();
      return { result: 'ok', matched };
    }

    case 'select': {
      const { element, matched } = resolveElement(step);
      const option = step.option as string;
      if (!option) {
        throw new Error('select command requires an "option" field');
      }
      await scrollAndSettle(element);
      await cursor.moveTo(element);
      const selectedText = actions.select(element, option);
      await waitForActionSettle();
      return { result: `selected "${selectedText}"`, matched };
    }

    case 'wait': {
      const { matched, elapsed } = await actions.wait(step);
      return { result: 'ok', matched, elapsed };
    }

    case 'styles': {
      const properties = step.properties as string[] | undefined;
      const result = getStyles(step, properties);
      return { result };
    }

    case 'evaluate': {
      const script = step.script as string;
      if (!script) {
        throw new Error('evaluate command requires a "script" field');
      }
      const result = await actions.evaluate(script);
      return { result };
    }

    default:
      throw new Error(`Unknown command: ${step.command}`);
  }
}
