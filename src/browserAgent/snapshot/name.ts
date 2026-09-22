/**
 * Accessible name computation — simplified W3C algorithm.
 *
 * Computes a human-readable name for an element following the priority:
 * aria-label → aria-labelledby → associated label → alt → legend/caption →
 * text content → title attribute.
 *
 * Reference: Playwright's getElementAccessibleName in roleUtils.ts for the
 * full W3C spec implementation.
 */

/**
 * Get the accessible name for an element.
 */
export function getAccessibleName(el: Element): string {
  // 1. aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    return ariaLabel.trim();
  }

  // 2. aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const name = labelledBy
      .split(/\s+/)
      .map((id) => {
        const ref = document.getElementById(id);
        return ref ? getTextContent(ref) : '';
      })
      .filter(Boolean)
      .join(' ');
    if (name) {
      return name;
    }
  }

  const tag = el.tagName.toLowerCase();

  // 3. Associated <label> for form controls
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const label = findAssociatedLabel(el as HTMLElement);
    if (label) {
      return label;
    }
  }

  // 4. <img> alt text
  if (tag === 'img') {
    const alt = (el as HTMLImageElement).alt;
    if (alt) {
      return alt.trim();
    }
  }

  // 5. <fieldset> → first <legend>
  if (tag === 'fieldset') {
    const legend = el.querySelector('legend');
    if (legend) {
      return getTextContent(legend);
    }
  }

  // 6. Text content for leaf/simple elements
  const text = getTextContent(el);
  if (text) {
    return text;
  }

  // 7. Title attribute as last resort
  const title = el.getAttribute('title');
  if (title) {
    return title.trim();
  }

  return '';
}

/**
 * Get visible text content of an element, with spaces between block-level children.
 * This fixes the "GenerateCollectionGenerate" problem — block elements get spaces.
 */
export function getTextContent(el: Element): string {
  // If the element has no child elements (leaf node), use textContent directly
  if (!el.children.length) {
    return (el.textContent || '').trim();
  }

  const parts: string[] = [];

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = (child.textContent || '').trim();
      if (text) {
        parts.push(text);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childEl = child as Element;

      // Skip hidden elements
      if (isHiddenForText(childEl)) {
        continue;
      }

      // Check if block-level — insert space boundaries
      const isBlock = isBlockLevel(childEl);
      const childText = getTextContent(childEl);
      if (childText) {
        if (isBlock && parts.length > 0) {
          // Ensure space before block content
          parts.push(' ');
        }
        parts.push(childText);
        if (isBlock) {
          parts.push(' ');
        }
      }
    }
  }

  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Find the associated <label> text for a form control.
 */
function findAssociatedLabel(el: HTMLElement): string | null {
  // Check for label[for="id"]
  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label) {
      return getTextContent(label);
    }
  }

  // Check for wrapping <label>
  const parent = el.closest('label');
  if (parent) {
    // Get label text excluding the control's own text
    const clone = parent.cloneNode(true) as HTMLElement;
    const control = clone.querySelector('input, textarea, select');
    if (control) {
      control.remove();
    }
    const text = clone.textContent?.trim();
    if (text) {
      return text;
    }
  }

  return null;
}

/**
 * Check if an element is block-level (for text spacing).
 */
function isBlockLevel(el: Element): boolean {
  try {
    const display = getComputedStyle(el).display;
    return !display.includes('inline');
  } catch {
    // Fallback: assume block for common block tags
    const tag = el.tagName.toLowerCase();
    return [
      'div',
      'p',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'li',
      'section',
      'article',
      'header',
      'footer',
      'nav',
      'main',
      'aside',
      'blockquote',
      'pre',
      'form',
      'fieldset',
      'table',
      'tr',
      'br',
    ].includes(tag);
  }
}

/**
 * Check if element should be excluded from text content.
 */
function isHiddenForText(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (
    tag === 'script' ||
    tag === 'style' ||
    tag === 'noscript' ||
    tag === 'template'
  ) {
    return true;
  }
  if (el.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  try {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Get pseudo-element text content (::before, ::after).
 */
export function getPseudoContent(
  el: Element,
  pseudo: '::before' | '::after',
): string {
  try {
    const content = getComputedStyle(el, pseudo).content;
    if (!content || content === 'none' || content === 'normal') {
      return '';
    }
    // Extract quoted string content
    const match = content.match(/^["'](.*)["']$/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}
