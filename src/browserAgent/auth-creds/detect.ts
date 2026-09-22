/**
 * Detection of auth-shaped inputs on the current page.
 *
 * Returns the first visible identifier (email or phone) and/or OTP code
 * target. OTP comes in two layouts, normalized into one `OtpTarget`:
 *   - a single multi-char input, or
 *   - a row of single-char boxes (segmented), one digit each.
 *
 * Strict autocomplete-attribute matches first, then loose name / placeholder /
 * aria-label heuristics.
 */

export interface AuthInputs {
  identifier: HTMLInputElement | null;
  identifierKind: 'email' | 'phone' | null;
  code: OtpTarget | null;
}

/**
 * An OTP target, normalized across the two common layouts.
 *   - `segmented: false` — one multi-char input (`cells` holds that one input).
 *   - `segmented: true`  — N single-char boxes in visual order.
 * `cells[0]` is the stable anchor used for identity comparisons.
 */
export interface OtpTarget {
  cells: HTMLInputElement[];
  segmented: boolean;
}

const EMAIL_STRICT = 'input[type="email"], input[autocomplete="email"]';
const TEL_STRICT = 'input[type="tel"], input[autocomplete="tel"]';
const OTP_STRICT = 'input[autocomplete="one-time-code"]';

const LOOSE_EMAIL_RE = /e[-_ ]?mail/i;
const LOOSE_PHONE_RE = /phone|mobile|\btel\b/i;
const LOOSE_OTP_RE = /\b(otp|code|verification|verify|2fa|one[-_ ]?time)\b/i;

// A segmented OTP row is this many single-char boxes. Fewer is probably not an
// OTP; more is probably something else (or several unrelated one-char fields).
const SEGMENT_MIN = 4;
const SEGMENT_MAX = 8;

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') {
    return false;
  }
  // Deliberately NOT rejecting opacity:0. The standard single-input OTP idiom
  // is one real <input> stretched transparent (opacity:0, color/caret
  // transparent) over painted digit "slots" — it stays the fully interactive,
  // hit-tested field the browser routes one-time-code autofill into. Treating
  // opacity:0 as hidden makes that entire (common, recommended) pattern
  // undetectable, so the widget never fills the code. display:none /
  // visibility:hidden / a zero-size rect already catch genuinely hidden
  // inputs; a transparent-but-laid-out input is real.
  return true;
}

function firstVisible(selector: string): HTMLInputElement | null {
  const nodes = document.querySelectorAll<HTMLInputElement>(selector);
  for (const n of nodes) {
    if (isVisible(n)) {
      return n;
    }
  }
  return null;
}

function inputHints(el: HTMLInputElement): string {
  const labelId = el.getAttribute('aria-labelledby');
  const labelEl = labelId ? document.getElementById(labelId) : null;
  return [
    el.name,
    el.id,
    el.placeholder,
    el.getAttribute('aria-label'),
    labelEl?.textContent,
  ]
    .filter(Boolean)
    .join(' ');
}

function findLoose(
  re: RegExp,
  predicate: (el: HTMLInputElement) => boolean,
): HTMLInputElement | null {
  const nodes = document.querySelectorAll<HTMLInputElement>(
    'input[type="text"], input:not([type])',
  );
  for (const n of nodes) {
    if (!predicate(n)) {
      continue;
    }
    if (!re.test(inputHints(n))) {
      continue;
    }
    if (!isVisible(n)) {
      continue;
    }
    return n;
  }
  return null;
}

function looksLikeOtp(el: HTMLInputElement): boolean {
  if (el.inputMode === 'numeric') {
    const max = el.maxLength;
    if (max >= 4 && max <= 8) {
      return true;
    }
  }
  const pattern = el.getAttribute('pattern') ?? '';
  if (/0-9/.test(pattern) && el.maxLength >= 4 && el.maxLength <= 8) {
    return true;
  }
  return false;
}

// A single OTP cell: a one-char box that's plausibly for a digit. We don't
// require a numeric hint — a lone maxlength=1 text box grouped with siblings is
// still very likely an OTP cell — and lean on the group-size gate to reject
// stray one-char fields.
function isSingleCharCell(el: HTMLInputElement): boolean {
  if (el.maxLength !== 1) {
    return false;
  }
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return type === 'text' || type === 'tel' || type === 'number';
}

// A row of single-char boxes, in visual order, or null if there isn't one.
function detectSegmentedOtp(): HTMLInputElement[] | null {
  const cells = Array.from(
    document.querySelectorAll<HTMLInputElement>('input'),
  ).filter((el) => isSingleCharCell(el) && isVisible(el));

  if (cells.length < SEGMENT_MIN || cells.length > SEGMENT_MAX) {
    return null;
  }

  // Order by visual position (rows top-to-bottom, then left-to-right) so we
  // fill left digit → right digit even if DOM order differs from layout.
  cells.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    if (Math.abs(ra.top - rb.top) > 8) {
      return ra.top - rb.top;
    }
    return ra.left - rb.left;
  });
  return cells;
}

function detectSingleCode(): HTMLInputElement | null {
  // A maxlength=1 box is never a whole-code field — it's a segmented cell we
  // caught before its siblings finished animating in. Dumping the code into it
  // would (via the native value-setter, which bypasses maxlength) cram all the
  // digits into one box. Reject it and let the poll wait for the full row.
  const strict = firstVisible(OTP_STRICT);
  let code: HTMLInputElement | null =
    strict && strict.maxLength !== 1 ? strict : null;
  if (!code) {
    const candidates = document.querySelectorAll<HTMLInputElement>(
      'input[inputmode="numeric"], input[type="text"]',
    );
    for (const n of candidates) {
      if (!looksLikeOtp(n)) {
        continue;
      }
      if (!isVisible(n)) {
        continue;
      }
      code = n;
      break;
    }
  }
  if (!code) {
    code = findLoose(
      LOOSE_OTP_RE,
      (el) => el.maxLength <= 8 && el.maxLength !== 1,
    );
  }
  return code;
}

export function detectAuthInputs(): AuthInputs {
  // Identifier — email first (more common), fall back to tel.
  let identifier: HTMLInputElement | null = firstVisible(EMAIL_STRICT);
  let identifierKind: 'email' | 'phone' | null = identifier ? 'email' : null;

  if (!identifier) {
    identifier = firstVisible(TEL_STRICT);
    identifierKind = identifier ? 'phone' : null;
  }

  if (!identifier) {
    identifier = findLoose(LOOSE_EMAIL_RE, () => true);
    if (identifier) {
      identifierKind = 'email';
    }
  }
  if (!identifier) {
    identifier = findLoose(LOOSE_PHONE_RE, () => true);
    if (identifier) {
      identifierKind = 'phone';
    }
  }

  // Code — segmented (N single-char boxes) first. Those boxes are maxlength=1,
  // so the single-input path below would mis-read the first box and keep only
  // one digit.
  const segmented = detectSegmentedOtp();
  let code: OtpTarget | null = segmented
    ? { cells: segmented, segmented: true }
    : null;

  if (!code) {
    const single = detectSingleCode();
    if (single) {
      code = { cells: [single], segmented: false };
    }
  }

  return { identifier, identifierKind, code };
}
