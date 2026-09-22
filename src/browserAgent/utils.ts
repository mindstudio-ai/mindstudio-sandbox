/**
 * Serialize a value for logging. Handles errors, objects, and primitives.
 */
export function serialize(val: unknown): string {
  if (val === null) {
    return 'null';
  }
  if (val === undefined) {
    return 'undefined';
  }
  if (val instanceof Error) {
    return val.stack || val.message || String(val);
  }
  if (typeof val === 'object') {
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
  }
  return String(val);
}

/**
 * Describe an element for interaction logging.
 * Uses the snapshot's accessible name/role computation to produce
 * clean output like `button "Create Board"` instead of `div.sc-aXZVf.ebODrC`.
 */
export { describeTarget as describeElement } from './snapshot/walker';

/**
 * Promise-based delay. Shared utility used by actions, poller, and cursor.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the primary scroll container on the page.
 *
 * Many apps render a fixed header/shell and put the scrollable content
 * inside a nested `overflow: auto|scroll` div. In that case `window.scrollBy`
 * is a no-op because the document itself doesn't overflow.
 *
 * Heuristic: pick the largest (by scrollable area) element with
 * overflow-y auto/scroll. Falls back to `document.documentElement` if
 * nothing qualifies.
 */
export function findScrollContainer(): HTMLElement {
  let best: HTMLElement | null = null;
  let bestScrollable = 0;

  for (const el of document.querySelectorAll('*')) {
    const html = el as HTMLElement;
    const overflow = getComputedStyle(html).overflowY;
    if (overflow !== 'auto' && overflow !== 'scroll') {
      continue;
    }
    const scrollable = html.scrollHeight - html.clientHeight;
    if (scrollable <= 20) {
      continue;
    }
    if (scrollable > bestScrollable) {
      bestScrollable = scrollable;
      best = html;
    }
  }

  return best ?? document.documentElement;
}
