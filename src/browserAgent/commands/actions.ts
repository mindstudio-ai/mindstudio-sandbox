/**
 * Browser actions — click, type, wait, evaluate.
 *
 * Click dispatches the full pointer/mouse/click event sequence so
 * React/Vue/Svelte handlers fire correctly.
 *
 * Type uses the native HTMLInputElement value setter trick for React
 * compatibility, with character-by-character dispatch for visual effect.
 */

import { resolveElement } from './resolve';
import { sleep } from '../utils';

// ---------------------------------------------------------------------------
// Click
// ---------------------------------------------------------------------------

export function click(element: Element): void {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const shared = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  };

  element.dispatchEvent(
    new PointerEvent('pointerdown', { ...shared, pointerId: 1 }),
  );
  element.dispatchEvent(new MouseEvent('mousedown', shared));

  // Focus between mousedown and pointerup (matches real browser behavior)
  if (element instanceof HTMLElement) {
    element.focus();
  }

  element.dispatchEvent(
    new PointerEvent('pointerup', { ...shared, pointerId: 1 }),
  );
  element.dispatchEvent(new MouseEvent('mouseup', shared));
  element.dispatchEvent(new MouseEvent('click', shared));
}

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

// Cache the native value setter — React overrides it on input elements
const nativeInputSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;

const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  'value',
)?.set;

export async function type(
  element: Element,
  text: string,
  opts: { clear?: boolean } = {},
): Promise<void> {
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
  ) {
    throw new Error('type command requires an input or textarea element');
  }

  // Focus the element
  element.focus();
  click(element);

  // Clear existing value if requested
  if (opts.clear) {
    setValue(element, '');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Type character by character with visual delay
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent('keypress', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
      }),
    );

    // Set value using native setter (bypasses React's override)
    setValue(element, element.value + char);

    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(
      new KeyboardEvent('keyup', {
        key: char,
        code: `Key${char.toUpperCase()}`,
        bubbles: true,
      }),
    );

    // Natural typing rhythm — speed scales with text length
    await sleep(typingDelay(char, text.length));
  }

  // Final change event
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Natural typing delay — varies by character to feel human.
 * Speed scales with text length so long inputs don't take forever:
 *   ≤20 chars:  full speed (85-140ms/char, ~2-3s total)
 *   50 chars:   ~60% speed
 *   100+ chars: ~30% speed (25-42ms/char, ~3-4s total)
 *   300+ chars: ~10% speed (8-14ms/char, ~3-4s total)
 */
function typingDelay(char: string, textLength: number): number {
  const jitter = Math.random() * 50 - 25; // ±25ms
  let base: number;
  if (char === ' ') {
    base = 120 + jitter;
  } else if (/[.,!?;:\-]/.test(char)) {
    base = 140 + jitter;
  } else if (/[A-Z]/.test(char)) {
    base = 115 + jitter;
  } else {
    base = 85 + jitter;
  }

  // Scale down for longer text — aim for roughly 3-5s total typing time
  if (textLength <= 20) {
    return base;
  }
  const scale = Math.max(0.1, 20 / textLength);
  return base * scale;
}

function setValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const setter =
    el instanceof HTMLTextAreaElement
      ? nativeTextareaSetter
      : nativeInputSetter;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
}

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

export async function wait(
  step: Record<string, unknown>,
): Promise<{ element: Element; matched: string; elapsed: number }> {
  const timeout = (step.timeout as number) || 5000;
  const startTime = Date.now();
  const deadline = startTime + timeout;

  while (Date.now() < deadline) {
    try {
      const result = resolveElement(step);
      // Element found — return immediately. The auto-snapshot in the
      // command response already waits for network idle, so the agent
      // gets a settled view without us blocking here.
      return { ...result, elapsed: Date.now() - startTime };
    } catch {
      // Element not found yet — keep polling
      await sleep(100);
    }
  }

  // Build a description of what we were looking for
  const desc = step.text
    ? `"${step.text}"`
    : step.role
      ? `role "${step.role}"`
      : step.selector
        ? `selector "${step.selector}"`
        : 'element';

  throw new Error(`Timed out waiting for ${desc} after ${timeout}ms`);
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

const nativeSelectSetter = Object.getOwnPropertyDescriptor(
  HTMLSelectElement.prototype,
  'value',
)?.set;

export function select(element: Element, option: string): string {
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error('select command requires a <select> element');
  }

  // Find matching option by text content, value, or label
  const lowerOption = option.toLowerCase();
  let matchedOption: HTMLOptionElement | null = null;

  for (const opt of element.options) {
    if (
      opt.text.toLowerCase().includes(lowerOption) ||
      opt.value.toLowerCase() === lowerOption ||
      opt.label.toLowerCase().includes(lowerOption)
    ) {
      matchedOption = opt;
      break;
    }
  }

  if (!matchedOption) {
    const available = [...element.options].map((o) => `"${o.text}"`).join(', ');
    throw new Error(
      `No option matching "${option}" in select. Available options: ${available}`,
    );
  }

  // Set value using native setter for React compatibility
  if (nativeSelectSetter) {
    nativeSelectSetter.call(element, matchedOption.value);
  } else {
    element.value = matchedOption.value;
  }

  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('input', { bubbles: true }));

  return matchedOption.text;
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

export async function evaluate(script: string): Promise<unknown> {
  try {
    // If the script is a bare expression (no statements / no explicit return),
    // wrap it as `return (...)` so the caller gets the value back. We detect
    // statement-shape scripts by the presence of `;`, `{`, or an explicit
    // `return`. `\b` word boundaries only apply to word characters, so they
    // would never match `;` / `{` — match those literally.
    const trimmed = script.trim();
    const isStatementShape = /\breturn\b/.test(trimmed) || /[;{]/.test(trimmed);
    const wrapped = isStatementShape ? script : `return (${script})`;
    // Compile as an ASYNC function body, not a plain `new Function`. A plain
    // Function is synchronous, so any script using top-level `await` (e.g.
    // `const r = await fetch('/api'); return r.status`) throws a SyntaxError —
    // "await is only valid in async functions" — at construction, before it
    // runs at all. Agents reach for `await` constantly, so build it async:
    // `await` is legal, a bare-expression `return (...)` still works, and the
    // (always-)promise result is awaited below. Sync scripts are unaffected —
    // an async function that never awaits just resolves immediately.
    const AsyncFunction = (async () => {}).constructor as new (
      body: string,
    ) => () => Promise<unknown>;
    const fn = new AsyncFunction(wrapped);
    // Make the value safe to JSON-serialize on the way back to the agent (see
    // serializeResult). Agents routinely `return document.querySelector(...)`
    // or a rich app object; the raw value would serialize to `{}` (DOM nodes),
    // throw and drop the whole command result → 120s timeout (circular refs),
    // or vanish (`undefined`).
    return serializeResult(await fn());
  } catch (err) {
    throw new Error(
      `evaluate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Bounds so a stray `return document.body` or a deep app-state object can't
// emit megabytes of JSON (token cost) or walk forever. Truncation is always
// marked so the agent can tell it happened and narrow its query.
const SER_MAX_DEPTH = 10;
const SER_MAX_ARRAY = 500;
const SER_MAX_KEYS = 500;
const SER_MAX_STRING = 20_000;
const SER_MAX_HTML = 1_000;

/**
 * Convert an arbitrary `evaluate` return value into something `JSON.stringify`
 * handles without throwing, blanking, or dropping it. Faithful where it can be
 * (primitives, plain objects/arrays), descriptive where it can't (DOM nodes,
 * functions, errors), and cycle-safe throughout. `seen` tracks the current
 * ancestor path only (deleted on the way out), so shared-but-acyclic refs (a
 * DAG) serialize fully — only true cycles become `'[Circular]'`.
 */
function serializeResult(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null) {
    return null;
  }

  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > SER_MAX_STRING
      ? `${s.slice(0, SER_MAX_STRING)}…(+${s.length - SER_MAX_STRING} chars)`
      : s;
  }
  if (t === 'number' || t === 'boolean') {
    return value;
  }
  if (t === 'undefined') {
    return '[undefined]';
  }
  if (t === 'bigint') {
    return `${(value as bigint).toString()}n`;
  }
  if (t === 'symbol') {
    return (value as symbol).toString();
  }
  if (t === 'function') {
    const name = (value as { name?: string }).name;
    return name ? `[Function: ${name}]` : '[Function]';
  }

  const obj = value as object;

  // DOM nodes serialize to `{}` by default — describe them instead. Use
  // getAttribute('class') not .className (SVG's className is an object).
  if (typeof Element !== 'undefined' && obj instanceof Element) {
    const html = obj.outerHTML ?? '';
    return {
      __type: 'Element',
      tag: obj.tagName.toLowerCase(),
      id: obj.id || undefined,
      class: obj.getAttribute('class') || undefined,
      text: (obj.textContent || '').trim().slice(0, 200) || undefined,
      html:
        html.length > SER_MAX_HTML ? `${html.slice(0, SER_MAX_HTML)}…` : html,
    };
  }
  if (typeof Node !== 'undefined' && obj instanceof Node) {
    return {
      __type: 'Node',
      nodeName: obj.nodeName,
      text: (obj.textContent || '').trim().slice(0, 200) || undefined,
    };
  }
  if (obj instanceof Error) {
    return {
      __type: 'Error',
      name: obj.name,
      message: obj.message,
      stack: obj.stack,
    };
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj instanceof RegExp) {
    return obj.toString();
  }

  if (seen.has(obj)) {
    return '[Circular]';
  }
  if (depth >= SER_MAX_DEPTH) {
    return '[Max depth]';
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      const arr: unknown[] = obj
        .slice(0, SER_MAX_ARRAY)
        .map((v) => serializeResult(v, depth + 1, seen));
      if (obj.length > SER_MAX_ARRAY) {
        arr.push(`…(+${obj.length - SER_MAX_ARRAY} more)`);
      }
      return arr;
    }
    if (obj instanceof Map) {
      const out: Record<string, unknown> = { __type: 'Map' };
      let i = 0;
      for (const [k, v] of obj) {
        if (i++ >= SER_MAX_KEYS) {
          out['…'] = `(+${obj.size - SER_MAX_KEYS} more)`;
          break;
        }
        out[String(k)] = serializeResult(v, depth + 1, seen);
      }
      return out;
    }
    if (obj instanceof Set) {
      return {
        __type: 'Set',
        values: [...obj]
          .slice(0, SER_MAX_ARRAY)
          .map((v) => serializeResult(v, depth + 1, seen)),
      };
    }

    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const key of keys) {
      if (i++ >= SER_MAX_KEYS) {
        out['…'] = `(+${keys.length - SER_MAX_KEYS} more)`;
        break;
      }
      out[key] = serializeResult(
        (obj as Record<string, unknown>)[key],
        depth + 1,
        seen,
      );
    }
    return out;
  } catch {
    // A hostile getter threw, or something else went wrong — never let result
    // serialization take down the command. Fall back to a string form.
    return `[Unserializable: ${Object.prototype.toString.call(obj)}]`;
  } finally {
    seen.delete(obj);
  }
}
