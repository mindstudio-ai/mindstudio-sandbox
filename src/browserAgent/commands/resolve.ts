/**
 * Element resolution — finds a DOM element from a command step's targeting fields.
 *
 * Resolution order:
 * 1. ref — lookup from last snapshot's ref map
 * 2. text — match accessible name or visible textContent
 * 3. role + text — match both role and name
 * 4. label — find input associated with a matching label
 * 5. selector — CSS selector fallback
 *
 * Error messages include what IS on the page so the agent can self-correct.
 */

import { getRefMap, describeTarget } from '../snapshot/walker';
import { getAccessibleName } from '../snapshot/name';
import { getRole } from '../snapshot/roles';

export interface ResolveResult {
  element: Element;
  matched: string;
}

export function resolveElement(step: Record<string, unknown>): ResolveResult {
  let result: ResolveResult | null = null;

  // 1. By ref
  if (step.ref) {
    const refMap = getRefMap();
    const el = refMap.get(step.ref as string);
    if (el && el.isConnected) {
      if (isVisible(el)) {
        result = {
          element: el,
          matched: `${describeTarget(el)} [ref=${step.ref}]`,
        };
      } else {
        throw new Error(
          `Element [ref=${step.ref}] exists but is hidden (${getHiddenReason(el)}). ` +
            `It may be inside a closed dialog or collapsed section.`,
        );
      }
    } else {
      const available = [...refMap.entries()]
        .filter(([, e]) => e.isConnected && isVisible(e))
        .slice(0, 10)
        .map(([r, e]) => `${describeTarget(e)} [ref=${r}]`)
        .join(', ');
      throw new Error(
        `Element [ref=${step.ref}] not found. ` +
          (available
            ? `Available refs: ${available}`
            : 'No refs available — take a snapshot first.'),
      );
    }
  }

  // 2. By text (optionally filtered by role)
  if (!result && (step.text || (step.role && step.text))) {
    const text = step.text as string;
    const role = step.role as string | undefined;
    const candidates = findByTextAndRole(text, role);

    if (candidates.length === 0) {
      // Check if it exists but is hidden
      const hidden = findByTextAndRole(text, role, true);
      if (hidden.length > 0) {
        throw new Error(
          `Found ${role ? role + ' ' : ''}"${text}" but it is hidden (${getHiddenReason(hidden[0])}). ` +
            `Wait for it to become visible or check if a dialog/modal needs to be opened first.`,
        );
      }

      // Suggest similar elements
      const desc = role ? `${role} "${text}"` : `"${text}"`;
      const suggestions = getSuggestions(role);
      throw new Error(
        `No element found matching ${desc}. ` +
          (suggestions
            ? `Visible ${role || 'element'}s: ${suggestions}`
            : 'The page may still be loading — try a wait command first.'),
      );
    }

    if (candidates.length > 1) {
      const interactive = candidates.filter(isInteractive);
      const pick = interactive.length === 1 ? interactive[0] : candidates[0];
      result = { element: pick, matched: describeTarget(pick) };
    } else {
      result = {
        element: candidates[0],
        matched: describeTarget(candidates[0]),
      };
    }
  }

  // 3. By role only (no text)
  if (!result && step.role && !step.text) {
    const role = step.role as string;
    const candidates = findByRole(role);

    if (candidates.length === 0) {
      const suggestions = getSuggestions(role);
      throw new Error(
        `No visible element with role "${role}" found. ` +
          (suggestions
            ? `Visible ${role}s: ${suggestions}`
            : 'The page may still be loading — try a wait command first.'),
      );
    }
    result = { element: candidates[0], matched: describeTarget(candidates[0]) };
  }

  // 4. By label
  if (!result && step.label) {
    const label = step.label as string;
    const el = findByLabel(label);
    if (!el) {
      const labels = [...document.querySelectorAll('label')]
        .filter(isVisible)
        .map((l) => `"${(l.textContent || '').trim().slice(0, 40)}"`)
        .slice(0, 8)
        .join(', ');
      throw new Error(
        `No input found with label "${label}". ` +
          (labels
            ? `Visible labels: ${labels}`
            : 'No labels found on the page.'),
      );
    }
    result = {
      element: el,
      matched: `${describeTarget(el)} via label "${label}"`,
    };
  }

  // 5. By CSS selector
  if (!result && step.selector) {
    const selector = step.selector as string;
    const el = document.querySelector(selector);
    if (!el) {
      throw new Error(`No element found for selector "${selector}".`);
    }
    if (!isVisible(el)) {
      throw new Error(
        `Found element for selector "${selector}" but it is hidden (${getHiddenReason(el)}).`,
      );
    }
    result = {
      element: el,
      matched: `${describeTarget(el)} via selector "${selector}"`,
    };
  }

  if (!result) {
    throw new Error(
      'No targeting field provided (need ref, text, role, label, or selector)',
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

function findByTextAndRole(
  text: string,
  role?: string,
  includeHidden = false,
): Element[] {
  const matches: Element[] = [];
  const lowerText = text.toLowerCase();

  for (const el of document.querySelectorAll('*')) {
    if (!includeHidden && !isVisible(el)) {
      continue;
    }
    if (includeHidden && !el.isConnected) {
      continue;
    }

    if (role) {
      const elRole = getRole(el);
      if (elRole !== role) {
        continue;
      }
    }

    const name = getAccessibleName(el);
    if (name.toLowerCase().includes(lowerText)) {
      matches.push(el);
      continue;
    }

    if (!el.children.length) {
      const elText = (el.textContent || '').trim();
      if (elText.toLowerCase().includes(lowerText)) {
        matches.push(el);
      }
    }
  }

  return matches;
}

function findByRole(role: string): Element[] {
  const matches: Element[] = [];

  for (const el of document.querySelectorAll('*')) {
    if (!isVisible(el)) {
      continue;
    }
    if (getRole(el) === role) {
      matches.push(el);
    }
  }

  return matches;
}

function findByLabel(labelText: string): Element | null {
  const lowerLabel = labelText.toLowerCase();

  for (const label of document.querySelectorAll('label')) {
    const text = (label.textContent || '').trim().toLowerCase();
    if (!text.includes(lowerLabel)) {
      continue;
    }

    const forAttr = label.getAttribute('for');
    if (forAttr) {
      const control = document.getElementById(forAttr);
      if (control && isVisible(control)) {
        return control;
      }
    }

    const control = label.querySelector('input, textarea, select');
    if (control && isVisible(control)) {
      return control;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Visibility + error helpers
// ---------------------------------------------------------------------------

function isVisible(el: Element): boolean {
  if (!el.isConnected) {
    return false;
  }
  try {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function isInteractive(el: Element): boolean {
  if (
    el.matches(
      'a, button, input, textarea, select, [role="button"], [role="link"], [tabindex]',
    )
  ) {
    return true;
  }
  try {
    return getComputedStyle(el).cursor === 'pointer';
  } catch {
    return false;
  }
}

function getHiddenReason(el: Element): string {
  try {
    const style = getComputedStyle(el);
    if (style.display === 'none') {
      return 'display: none';
    }
    if (style.visibility === 'hidden') {
      return 'visibility: hidden';
    }
  } catch {
    // disconnected
  }
  if (el.getAttribute('aria-hidden') === 'true') {
    return 'aria-hidden="true"';
  }
  return 'hidden';
}

/**
 * Get a list of visible elements of a given role (or all interactive elements)
 * for error message suggestions.
 */
function getSuggestions(role?: string): string {
  const elements: Element[] = [];

  for (const el of document.querySelectorAll('*')) {
    if (!isVisible(el)) {
      continue;
    }
    if (role) {
      if (getRole(el) === role) {
        elements.push(el);
      }
    } else if (isInteractive(el)) {
      elements.push(el);
    }
    if (elements.length >= 10) {
      break;
    }
  }

  if (elements.length === 0) {
    return '';
  }
  return elements
    .map(
      (el) => `"${getAccessibleName(el).slice(0, 40) || describeTarget(el)}"`,
    )
    .join(', ');
}
