/**
 * DOM snapshot walker — produces a compact, accessibility-tree-style
 * representation of the page.
 *
 * Design inspired by Vercel's agent-browser (ref-based element targeting)
 * and Playwright's ariaSnapshot.ts (transparent element collapsing, block
 * spacing, W3C name computation).
 *
 * Key technique: elements without a semantic role (generic divs, spans,
 * styled-components wrappers) are transparent — their children float up
 * to the nearest semantic ancestor. This collapses the wrapper noise.
 */

import { getRole, isCursorInteractive } from './roles';
import { getAccessibleName, getTextContent, getPseudoContent } from './name';
import { waitForNetworkIdle } from '../network-idle';
import { getState } from '../state';

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export function getRefMap(): Map<string, Element> {
  return getState().snapshot.refMap;
}

interface AriaNode {
  tag: string | null; // null = transparent (generic div/span)
  name: string;
  attrs: string[];
  ref: string | null;
  children: AriaNode[];
  element: Element;
}

/**
 * Take a snapshot of the current page DOM.
 * Waits for network requests to settle before walking, so the snapshot
 * reflects the fully loaded page rather than a loading state.
 * Returns a compact text tree with refs for interactive elements.
 */
export async function takeSnapshot(): Promise<string> {
  await waitForNetworkIdle();
  return takeSnapshotSync();
}

/**
 * Take a snapshot immediately without waiting for network idle.
 */
export function takeSnapshotSync(): string {
  const s = getState().snapshot;
  s.refCounter = 0;
  s.refMap = new Map();

  const root = document.body;
  if (!root) {
    return '(empty page)';
  }

  const nodes = walkElement(root);
  return renderNodes(nodes, 0).trimEnd();
}

/**
 * Describe a single element for click/interaction logging.
 * Returns something like: `button "Create Board"` instead of `div.sc-aXZVf.ebODrC`.
 */
export function describeTarget(el: Element): string {
  const role = getRole(el);
  const name = getAccessibleName(el);
  const truncatedName = name.length > 60 ? name.slice(0, 57) + '...' : name;

  if (role && truncatedName) {
    return `${role} "${truncatedName}"`;
  }
  if (role) {
    return role;
  }
  if (truncatedName) {
    return `"${truncatedName}"`;
  }

  // Fallback: tag + id
  const tag = el.tagName.toLowerCase();
  if (el.id) {
    return `${tag}#${el.id}`;
  }
  return tag;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

function walkElement(el: Element): AriaNode[] {
  if (isHidden(el)) {
    return [];
  }

  const role = getRole(el);
  const cursorInteractive = !role && isCursorInteractive(el);
  const tag = role || (cursorInteractive ? 'clickable' : null);

  // Compute accessible name
  let name = '';
  if (tag) {
    name = getAccessibleName(el);

    // Include pseudo-element content
    const before = getPseudoContent(el, '::before');
    const after = getPseudoContent(el, '::after');
    if (before || after) {
      const full = [before, name, after].filter(Boolean).join(' ');
      name = full;
    }

    // Truncate
    if (name.length > 80) {
      name = name.slice(0, 77) + '...';
    }
  }

  // Compute state attributes
  const attrs = getStateAttrs(el);

  // Decide if this element gets a ref
  const isInteractive =
    role === 'button' ||
    role === 'link' ||
    role === 'textbox' ||
    role === 'combobox' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'slider' ||
    role === 'tab' ||
    role === 'menuitem' ||
    cursorInteractive;
  const isNamedLandmark = tag && name && !isInteractive;

  let ref: string | null = null;
  if (isInteractive || isNamedLandmark) {
    const s = getState().snapshot;
    s.refCounter++;
    ref = `e${s.refCounter}`;
    s.refMap.set(ref, el);
  }

  // Walk children
  const childNodes = walkChildren(el);

  // If this element has a semantic role, create a node
  if (tag) {
    // Text deduplication: if the only child content matches the name, suppress children
    const childText =
      childNodes.length === 0 ? '' : renderNodes(childNodes, 0).trim();
    const dedupedChildren = childText && childText === name ? [] : childNodes;

    return [
      {
        tag,
        name,
        attrs,
        ref,
        children: dedupedChildren,
        element: el,
      },
    ];
  }

  // Transparent element: children float up.
  // But if this element has no child AriaNodes and contains visible text,
  // emit it as a text node so it doesn't vanish entirely.
  if (childNodes.length === 0) {
    const text = getTextContent(el);
    if (text) {
      return [
        {
          tag: null,
          name: text.length > 80 ? text.slice(0, 77) + '...' : text,
          attrs: [],
          ref: null,
          children: [],
          element: el,
        },
      ];
    }
  }

  return childNodes;
}

function walkChildren(el: Element): AriaNode[] {
  const children: AriaNode[] = [];

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      children.push(...walkElement(child as Element));
    }
    // Text nodes are handled by getAccessibleName/getTextContent,
    // not as separate AriaNodes
  }

  return children;
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

function isHidden(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (
    tag === 'script' ||
    tag === 'style' ||
    tag === 'noscript' ||
    tag === 'template' ||
    tag === 'head'
  ) {
    return true;
  }

  if (el.getAttribute('aria-hidden') === 'true') {
    return true;
  }

  // Skip our own injected elements
  if (
    el.id === '__mindstudio-browser-agent' ||
    el.id === '__mindstudio-cursor' ||
    el.id === '__mindstudio-cursor-ripple' ||
    el.id === '__mindstudio-notes-host'
  ) {
    return true;
  }

  try {
    const style = getComputedStyle(el);
    if (style.display === 'none') {
      return true;
    }
    if (style.visibility === 'hidden' && style.position !== 'static') {
      return true;
    }
  } catch {
    // getComputedStyle can fail for disconnected elements
  }

  return false;
}

// ---------------------------------------------------------------------------
// State attributes
// ---------------------------------------------------------------------------

function getStateAttrs(el: Element): string[] {
  const attrs: string[] = [];
  const tag = el.tagName.toLowerCase();

  // Open state
  if (
    (tag === 'dialog' && (el as HTMLDialogElement).open) ||
    (tag === 'details' && (el as HTMLDetailsElement).open)
  ) {
    attrs.push('open');
  }

  // Disabled
  if ((el as HTMLButtonElement | HTMLInputElement).disabled) {
    attrs.push('disabled');
  }

  // Checked
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio') {
      if (input.checked) {
        attrs.push('checked');
      }
    }
  }

  // Value and placeholder for form controls
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    if (
      input.type !== 'checkbox' &&
      input.type !== 'radio' &&
      input.type !== 'hidden' &&
      input.type !== 'submit' &&
      input.type !== 'button' &&
      input.type !== 'reset'
    ) {
      attrs.push(`value="${input.value}"`);
      if (input.placeholder) {
        attrs.push(`placeholder="${input.placeholder}"`);
      }
    }
  }
  if (tag === 'textarea') {
    const textarea = el as HTMLTextAreaElement;
    attrs.push(`value="${textarea.value}"`);
    if (textarea.placeholder) {
      attrs.push(`placeholder="${textarea.placeholder}"`);
    }
  }
  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    const selected = select.options[select.selectedIndex];
    if (selected) {
      attrs.push(`value="${selected.text}"`);
    }
  }

  // Heading level
  const headingMatch = tag.match(/^h([1-6])$/);
  if (headingMatch) {
    attrs.push(`level=${headingMatch[1]}`);
  }

  // ARIA expanded
  const expanded = el.getAttribute('aria-expanded');
  if (expanded === 'true') {
    attrs.push('expanded');
  }
  if (expanded === 'false') {
    attrs.push('collapsed');
  }

  // ARIA selected
  if (el.getAttribute('aria-selected') === 'true') {
    attrs.push('selected');
  }

  // ARIA pressed
  if (el.getAttribute('aria-pressed') === 'true') {
    attrs.push('pressed');
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNodes(nodes: AriaNode[], depth: number): string {
  let output = '';
  for (const node of nodes) {
    output += renderNode(node, depth);
  }
  return output;
}

function renderNode(node: AriaNode, depth: number): string {
  const indent = '  '.repeat(depth);

  // Build the line: tag "name" [attrs] [ref=eN]
  const parts: string[] = [];
  if (node.tag) {
    parts.push(node.tag);
  }
  if (node.name) {
    parts.push(`"${node.name}"`);
  }
  for (const attr of node.attrs) {
    parts.push(`[${attr}]`);
  }
  if (node.ref) {
    parts.push(`[ref=${node.ref}]`);
  }

  let output = '';
  if (parts.length > 0) {
    output += `${indent}${parts.join(' ')}\n`;
  }

  // Render children at deeper indent (or same indent if this node had no line)
  const childDepth = parts.length > 0 ? depth + 1 : depth;
  output += renderNodes(node.children, childDepth);

  return output;
}
