/**
 * Implicit ARIA role mapping for common HTML elements.
 *
 * Elements not in this map and without an explicit role attribute are treated
 * as generic — they become transparent in the snapshot (children float up).
 * This is the key mechanism for collapsing styled-components wrapper noise.
 *
 * Reference: Playwright's roleUtils.ts kImplicitRoleByTagName for edge cases.
 */

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  input: 'textbox',
  textarea: 'textbox',
  select: 'combobox',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  dialog: 'dialog',
  details: 'group',
  summary: 'button',
  img: 'img',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  th: 'columnheader',
  td: 'cell',
  form: 'form',
  article: 'article',
  section: 'region',
  label: 'label',
  fieldset: 'group',
  legend: 'legend',
  p: 'paragraph',
  blockquote: 'blockquote',
  pre: 'code',
  code: 'code',
  hr: 'separator',
  progress: 'progressbar',
};

/**
 * Get the effective ARIA role for an element.
 * Returns null for generic elements (div, span, etc.) — these are transparent.
 */
export function getRole(el: Element): string | null {
  // Explicit role attribute takes precedence
  const explicit = el.getAttribute('role');
  if (explicit) {
    if (explicit === 'presentation' || explicit === 'none') {
      return null;
    }
    return explicit;
  }

  const tag = el.tagName.toLowerCase();

  // Contextual role rules
  if (tag === 'a') {
    return el.hasAttribute('href') ? 'link' : null;
  }
  if (tag === 'section') {
    return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
      ? 'region'
      : null;
  }
  if (tag === 'form') {
    return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
      ? 'form'
      : null;
  }
  if (tag === 'img') {
    return (el as HTMLImageElement).alt === '' ? null : 'img';
  }

  // Input type variations
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    switch (type) {
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'range':
        return 'slider';
      case 'submit':
      case 'button':
      case 'reset':
        return 'button';
      case 'hidden':
        return null;
      default:
        return 'textbox';
    }
  }

  return IMPLICIT_ROLES[tag] ?? null;
}

/**
 * Check if an element is interactive (should get a ref even if generic).
 * Detects cursor:pointer divs and onclick handlers — the agent-browser -C approach.
 */
export function isCursorInteractive(el: Element): boolean {
  // Has onclick attribute
  if (el.hasAttribute('onclick')) {
    return true;
  }

  // Has tabindex (explicitly made focusable)
  if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') {
    return true;
  }

  // Has cursor: pointer style
  try {
    const style = getComputedStyle(el);
    if (style.cursor === 'pointer') {
      return true;
    }
  } catch {
    // getComputedStyle can fail in edge cases
  }

  return false;
}
