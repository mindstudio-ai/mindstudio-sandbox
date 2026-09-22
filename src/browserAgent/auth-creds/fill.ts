/**
 * Fill inputs the way the user would, then submit the surrounding form.
 *
 * `fillAndSubmit` handles the identifier (a single text field). `fillOtp`
 * handles the code, which may be one multi-char input or a row of single-char
 * boxes — the segmented case is filled per-cell so components that keep only
 * the first character (and advance focus) receive one digit at a time.
 *
 * Value-set path mirrors `src/commands/actions.ts` (`setValue` + native setter
 * cache). Events are dispatched to look like real typing: `beforeinput` +
 * `input` (as `InputEvent`s carrying `data`, which some libraries read) +
 * `change`, plus per-key `keydown`/`keyup` for the segmented path. Submission
 * tries `form.requestSubmit()` first, then an Enter keypress for formless UIs.
 */

import type { OtpTarget } from './detect';

const nativeInputSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
)?.set;

function setValue(el: HTMLInputElement, value: string): void {
  if (nativeInputSetter) {
    nativeInputSetter.call(el, value);
  } else {
    el.value = value;
  }
}

function dispatchTextEvent(
  el: HTMLInputElement,
  type: 'beforeinput' | 'input',
  data: string,
): void {
  let evt: Event;
  try {
    // InputEvent carries `data`/`inputType` some frameworks inspect; it also
    // satisfies React, which only reads `target.value`.
    evt = new InputEvent(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      inputType: 'insertText',
      data,
    });
  } catch {
    evt = new Event(type, { bubbles: true });
  }
  el.dispatchEvent(evt);
}

function dispatchKey(el: HTMLInputElement, key: string): void {
  const init: KeyboardEventInit = {
    key,
    code: /^[0-9]$/.test(key) ? `Digit${key}` : key,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
}

function fillInput(el: HTMLInputElement, value: string): void {
  el.focus();
  setValue(el, value);
  dispatchTextEvent(el, 'beforeinput', value);
  dispatchTextEvent(el, 'input', value);
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function submitFrom(el: HTMLInputElement): void {
  const form = el.closest('form');
  if (form && typeof form.requestSubmit === 'function') {
    try {
      form.requestSubmit();
      return;
    } catch {
      // requestSubmit throws if the form has no submitter. Fall through.
    }
  }

  const opts: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

/** Fill a single text input and submit its form (used for the identifier). */
export function fillAndSubmit(el: HTMLInputElement, value: string): void {
  fillInput(el, value);
  submitFrom(el);
}

/**
 * Fill an OTP target and submit. Returns the value now present across the
 * target's cells so the caller can verify the fill actually took — framework
 * re-renders sometimes reject or truncate a programmatic value, and the caller
 * retries when it doesn't match.
 */
export function fillOtp(target: OtpTarget, code: string): string {
  if (target.segmented) {
    target.cells.forEach((cell, i) => {
      const ch = code[i] ?? '';
      cell.focus();
      setValue(cell, ch);
      dispatchTextEvent(cell, 'beforeinput', ch);
      dispatchTextEvent(cell, 'input', ch);
      cell.dispatchEvent(new Event('change', { bubbles: true }));
      if (ch) {
        dispatchKey(cell, ch);
      }
    });
  } else {
    fillInput(target.cells[0], code);
  }
  submitOtp(target);
  return readOtp(target);
}

/** The value currently across an OTP target's cells (joined). */
export function readOtp(target: OtpTarget): string {
  return target.cells.map((c) => c.value).join('');
}

/** Submit the form the OTP target belongs to (via its last cell). */
export function submitOtp(target: OtpTarget): void {
  const anchor = target.cells[target.cells.length - 1] ?? target.cells[0];
  if (anchor) {
    submitFrom(anchor);
  }
}
