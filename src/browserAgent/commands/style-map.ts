/**
 * Visual context extraction — produces a compact, token-efficient text
 * description of the rendered visual state of the page.
 *
 * Paired with screenshots to give LLMs precise measurements they can't
 * extract from pixels: resolved font sizes, actual line counts, overflow
 * detection, element dimensions as % of viewport, spatial overlaps.
 *
 * Output is plain text optimized for LLM consumption, not JSON.
 */

import { getRole } from '../snapshot/roles';
import { getAccessibleName } from '../snapshot/name';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ElementEntry {
  label: string; // e.g. 'button "Sign up"'
  rect: DOMRect;
  style: CSSStyleDeclaration;
  el: Element;
  tag: string;
}

interface OverlapEntry {
  a: string;
  b: string;
  overlapPx: number;
  axis: 'vertical' | 'horizontal';
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKIP_IDS = new Set([
  '__mindstudio-browser-agent',
  '__mindstudio-cursor',
  '__mindstudio-cursor-ripple',
  '__mindstudio-notes-overlay',
  '__mindstudio-notes-cursor',
]);

// Visual properties worth reporting for non-text elements
const HAS_VISUAL_PRESENCE_PROPS = [
  'backgroundColor',
  'backgroundImage',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'boxShadow',
] as const;

// Max text content length in labels
const MAX_LABEL_LEN = 60;
// Max entries before we start collapsing
const MAX_ENTRIES = 80;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function computeStyleMap(): string {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scrollY = window.scrollY;
  const docHeight = document.documentElement.scrollHeight;

  const lines: string[] = [];
  lines.push(`viewport: ${vw} \u00d7 ${vh}`);
  lines.push(
    `scroll: ${Math.round(scrollY)} / ${docHeight} (${scrollY < 10 ? 'top' : scrollY + vh >= docHeight - 10 ? 'bottom' : Math.round((scrollY / (docHeight - vh)) * 100) + '%'})`,
  );
  lines.push('');

  const entries: ElementEntry[] = [];
  const root = document.body;
  if (!root) {
    return lines.join('\n') + '(empty page)';
  }

  collectEntries(root, entries, vw, vh, scrollY);

  // Collapse repeated siblings
  const collapsed = collapseRepeated(entries);

  // Render entries
  for (const item of collapsed) {
    if ('count' in item) {
      // Collapsed group
      const g = item as CollapsedGroup;
      lines.push(
        `[${g.count} ${g.role}, each ~${g.avgWidth} \u00d7 ${g.avgHeight}, first: "${g.firstName}", last: "${g.lastName}"]`,
      );
      lines.push('');
    } else {
      const e = item as ElementEntry;
      renderEntry(e, lines, vw, vh, scrollY);
    }
  }

  // Detect overlaps between sibling entries
  const overlaps = detectOverlaps(entries);
  if (overlaps.length > 0) {
    for (const o of overlaps) {
      lines.push(
        `\u00d7 ${o.a} overlaps ${o.b} by ${o.overlapPx}px ${o.axis}ly`,
      );
    }
    lines.push('');
  }

  // Off-viewport elements
  const offscreen = entries.filter((e) => {
    const r = e.rect;
    return (
      r.right < 0 || r.left > vw || r.bottom < -scrollY || r.top > vh + scrollY
    );
  });
  for (const e of offscreen) {
    const r = e.rect;
    let dir = '';
    if (r.right < 0) {
      dir = `left: ${Math.round(r.left)}px`;
    } else if (r.left > vw) {
      dir = `left: ${Math.round(r.left)}px`;
    } else if (r.bottom < 0) {
      dir = `top: ${Math.round(r.top)}px`;
    } else {
      dir = `top: ${Math.round(r.top)}px`;
    }
    lines.push(`\u00d7 ${e.label} \u2014 off-viewport (${dir})`);
  }

  return lines.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function collectEntries(
  el: Element,
  entries: ElementEntry[],
  vw: number,
  vh: number,
  scrollY: number,
): void {
  if (isSkipped(el)) {
    return;
  }
  if (entries.length >= MAX_ENTRIES) {
    return;
  }

  const tag = el.tagName.toLowerCase();
  const role = getRole(el);
  const hasText = hasDirectText(el);
  const isSemantic = role !== null;
  const isImg =
    tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video';
  const isFormControl =
    tag === 'input' || tag === 'textarea' || tag === 'select';

  let include = isSemantic || isImg || isFormControl;

  // Include non-semantic elements with visual presence (background, border)
  if (!include && hasVisualPresence(el)) {
    include = true;
  }

  // But skip generic wrappers that are semantic but have no direct content
  // (e.g. <nav>, <main>, <section>) — their children will be included
  if (include && !hasText && !isImg && !isFormControl && isContainer(role)) {
    include = false;
  }

  if (include) {
    const rect = el.getBoundingClientRect();
    // Skip zero-size elements
    if (rect.width > 0 && rect.height > 0) {
      try {
        const style = getComputedStyle(el);
        const label = buildLabel(el, role, tag);
        entries.push({ label, rect, style, el, tag });
      } catch {
        // getComputedStyle can fail for disconnected elements
      }
    }
  }

  // Recurse
  for (const child of Array.from(el.children)) {
    collectEntries(child, entries, vw, vh, scrollY);
  }
}

function isSkipped(el: Element): boolean {
  if (SKIP_IDS.has(el.id)) {
    return true;
  }

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

  try {
    const style = getComputedStyle(el);
    if (style.display === 'none') {
      return true;
    }
    if (style.visibility === 'hidden') {
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function hasDirectText(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
      return true;
    }
  }
  return false;
}

function hasVisualPresence(el: Element): boolean {
  try {
    const style = getComputedStyle(el);
    for (const prop of HAS_VISUAL_PRESENCE_PROPS) {
      const val = style[prop as any] as string;
      if (
        !val ||
        val === 'none' ||
        val === '0px' ||
        val === 'rgba(0, 0, 0, 0)' ||
        val === 'transparent'
      ) {
        continue;
      }
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

function isContainer(role: string | null): boolean {
  return (
    role === 'navigation' ||
    role === 'main' ||
    role === 'banner' ||
    role === 'contentinfo' ||
    role === 'complementary' ||
    role === 'region' ||
    role === 'form' ||
    role === 'list' ||
    role === 'table' ||
    role === 'article' ||
    role === 'group'
  );
}

// ---------------------------------------------------------------------------
// Labeling
// ---------------------------------------------------------------------------

function buildLabel(el: Element, role: string | null, tag: string): string {
  const name = getAccessibleName(el);
  const truncated =
    name.length > MAX_LABEL_LEN
      ? name.slice(0, MAX_LABEL_LEN - 1) + '\u2026'
      : name;

  if (role && truncated) {
    return `${role} "${truncated}"`;
  }
  if (role) {
    return role;
  }
  if (truncated) {
    return `${tag} "${truncated}"`;
  }

  // Fallback
  if (el.id) {
    return `${tag}#${el.id}`;
  }
  const className =
    el.className && typeof el.className === 'string'
      ? el.className
          .split(/\s+/)
          .find(
            (c) =>
              !c.startsWith('sc-') && !c.startsWith('css-') && c.length < 30,
          )
      : null;
  if (className) {
    return `${tag}.${className}`;
  }
  return tag;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEntry(
  e: ElementEntry,
  lines: string[],
  vw: number,
  vh: number,
  scrollY: number,
): void {
  const { label, rect, style, el, tag } = e;
  const w = Math.round(rect.width);
  const h = Math.round(rect.height);
  const x = Math.round(rect.left);
  const y = Math.round(rect.top + scrollY); // document-relative

  // First line: label + typography
  const typoParts: string[] = [];
  const isTextElement =
    hasDirectText(el) || tag === 'input' || tag === 'textarea';

  if (isTextElement) {
    typoParts.push(style.fontSize);
    // Only include font-family if it's not a generic system font
    const font = cleanFontFamily(style.fontFamily);
    if (font) {
      typoParts.push(`"${font}"`);
    }
    const weight = style.fontWeight;
    if (weight !== '400' && weight !== 'normal') {
      typoParts.push(weight);
    }
    // Color
    typoParts.push(rgbToHex(style.color));
    // Background color if notable
    const bg = rgbToHex(style.backgroundColor);
    if (bg && bg !== 'transparent') {
      typoParts.push(`on ${bg}`);
    }
  } else if (
    tag === 'img' ||
    tag === 'svg' ||
    tag === 'canvas' ||
    tag === 'video'
  ) {
    // Visual elements — report dimensions inline
  } else {
    // Non-text element with visual presence
    const bg = rgbToHex(style.backgroundColor);
    if (bg && bg !== 'transparent') {
      typoParts.push(`bg: ${bg}`);
    }
  }

  const typoStr = typoParts.length > 0 ? ` \u2014 ${typoParts.join(' ')}` : '';
  lines.push(`${label}${typoStr}`);

  // Second line: geometry
  const geoParts: string[] = [];
  geoParts.push(`${w} \u00d7 ${h}`);
  geoParts.push(`at (${x}, ${y})`);
  geoParts.push(`${((w / vw) * 100).toFixed(1)}% vw`);

  // Image aspect ratio
  if (tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video') {
    if (w > 0 && h > 0) {
      const ratio = simplifyRatio(w, h);
      geoParts.push(`aspect: ${ratio}`);
    }
  }

  // Line count for text elements
  if (isTextElement) {
    const lineInfo = countLines(el, style);
    if (lineInfo) {
      geoParts.push(`${lineInfo.lines} line${lineInfo.lines !== 1 ? 's' : ''}`);
      if (lineInfo.capacity !== null) {
        geoParts.push(
          `(line-height: ${lineInfo.lineHeight}, capacity: ${lineInfo.capacity.toFixed(1)})`,
        );
      }
    }
  }

  lines.push(`  ${geoParts.join(', ')}`);

  // Third line: overflow (only if detected)
  const overflow = detectOverflow(el);
  if (overflow) {
    lines.push(`  ${overflow}`);
  }

  lines.push('');
}

// ---------------------------------------------------------------------------
// Line counting
// ---------------------------------------------------------------------------

interface LineInfo {
  lines: number;
  lineHeight: string;
  capacity: number | null;
}

function countLines(el: Element, style: CSSStyleDeclaration): LineInfo | null {
  // Find the first text node
  const textNode = findFirstTextNode(el);
  if (!textNode || !textNode.textContent?.trim()) {
    return null;
  }

  try {
    const range = document.createRange();
    range.selectNodeContents(textNode.parentElement || el);
    const rects = range.getClientRects();
    if (rects.length === 0) {
      return null;
    }

    // Each rect is roughly one line
    const lineCount = rects.length;
    const lh = style.lineHeight;
    const lhPx = parseFloat(lh);

    let capacity: number | null = null;
    if (!isNaN(lhPx) && lhPx > 0) {
      const containerHeight = el.clientHeight;
      capacity = containerHeight / lhPx;
    }

    return {
      lines: lineCount,
      lineHeight: isNaN(lhPx) ? lh : `${Math.round(lhPx)}px`,
      capacity,
    };
  } catch {
    return null;
  }
}

function findFirstTextNode(el: Element): Text | null {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && (child.textContent || '').trim()) {
      return child as Text;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const found = findFirstTextNode(child as Element);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overflow detection
// ---------------------------------------------------------------------------

function detectOverflow(el: Element): string | null {
  const htmlEl = el as HTMLElement;
  const sw = htmlEl.scrollWidth;
  const sh = htmlEl.scrollHeight;
  const cw = htmlEl.clientWidth;
  const ch = htmlEl.clientHeight;

  if (sw <= cw && sh <= ch) {
    return null;
  }

  const style = getComputedStyle(el);
  const overflowX = style.overflowX;
  const overflowY = style.overflowY;
  const textOverflow = style.textOverflow;

  const parts: string[] = [];

  if (sw > cw) {
    const pctHidden = Math.round(((sw - cw) / sw) * 100);
    const behavior =
      textOverflow === 'ellipsis'
        ? 'ellipsis'
        : overflowX === 'hidden'
          ? 'hidden'
          : 'scroll';
    parts.push(
      `container: ${cw}px, content: ${sw}px wide, overflow: ${behavior} (${pctHidden}% hidden)`,
    );
  }

  if (sh > ch && overflowY !== 'visible') {
    const pctHidden = Math.round(((sh - ch) / sh) * 100);
    const behavior = overflowY === 'hidden' ? 'hidden' : 'scroll';
    parts.push(
      `container: ${ch}px, content: ${sh}px tall, overflow: ${behavior} (${pctHidden}% hidden)`,
    );
  }

  return parts.length > 0 ? parts.join('; ') : null;
}

// ---------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------

function detectOverlaps(entries: ElementEntry[]): OverlapEntry[] {
  const overlaps: OverlapEntry[] = [];

  // Only check elements that share a parent
  const byParent = new Map<Element | null, ElementEntry[]>();
  for (const e of entries) {
    const parent = e.el.parentElement;
    const group = byParent.get(parent) || [];
    group.push(e);
    byParent.set(parent, group);
  }

  for (const siblings of byParent.values()) {
    if (siblings.length < 2) {
      continue;
    }
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i].rect;
        const b = siblings[j].rect;
        // Check vertical overlap
        const vOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        const hOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (vOverlap > 2 && hOverlap > 2) {
          // Elements truly overlap in both axes
          const mainAxis = vOverlap < hOverlap ? 'vertical' : 'horizontal';
          const px = Math.round(Math.min(vOverlap, hOverlap));
          overlaps.push({
            a: siblings[i].label,
            b: siblings[j].label,
            overlapPx: px,
            axis: mainAxis,
          });
        }
      }
    }
  }

  return overlaps.slice(0, 5); // Cap at 5 to avoid noise
}

// ---------------------------------------------------------------------------
// Collapsing repeated siblings
// ---------------------------------------------------------------------------

interface CollapsedGroup {
  count: number;
  role: string;
  avgWidth: number;
  avgHeight: number;
  firstName: string;
  lastName: string;
}

type RenderItem = ElementEntry | CollapsedGroup;

function collapseRepeated(entries: ElementEntry[]): RenderItem[] {
  if (entries.length === 0) {
    return [];
  }

  const result: RenderItem[] = [];
  let i = 0;

  while (i < entries.length) {
    const current = entries[i];
    const parent = current.el.parentElement;
    const role = getRole(current.el);

    // Look for consecutive entries with the same parent and role
    if (role && parent) {
      let j = i + 1;
      while (
        j < entries.length &&
        entries[j].el.parentElement === parent &&
        getRole(entries[j].el) === role
      ) {
        j++;
      }
      const count = j - i;
      if (count >= 4) {
        // Collapse
        const group = entries.slice(i, j);
        const avgW = Math.round(
          group.reduce((s, e) => s + e.rect.width, 0) / count,
        );
        const avgH = Math.round(
          group.reduce((s, e) => s + e.rect.height, 0) / count,
        );
        const firstName = getAccessibleName(group[0].el);
        const lastName = getAccessibleName(group[count - 1].el);
        result.push({
          count,
          role,
          avgWidth: avgW,
          avgHeight: avgH,
          firstName:
            firstName.length > 40
              ? firstName.slice(0, 39) + '\u2026'
              : firstName,
          lastName:
            lastName.length > 40 ? lastName.slice(0, 39) + '\u2026' : lastName,
        });
        i = j;
        continue;
      }
    }

    result.push(current);
    i++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rgbToHex(rgb: string): string {
  if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') {
    return 'transparent';
  }

  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) {
    return rgb;
  }

  const r = parseInt(match[1]);
  const g = parseInt(match[2]);
  const b = parseInt(match[3]);
  const a = match[4] !== undefined ? parseFloat(match[4]) : 1;

  if (a < 1) {
    return `rgba(${r},${g},${b},${a})`;
  }

  return '#' + [r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('');
}

function cleanFontFamily(fontFamily: string): string {
  // Extract the first non-generic font
  const fonts = fontFamily
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''));
  const generic = new Set([
    'serif',
    'sans-serif',
    'monospace',
    'cursive',
    'fantasy',
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
  ]);
  const meaningful = fonts.find((f) => !generic.has(f));
  return meaningful || '';
}

function simplifyRatio(w: number, h: number): string {
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  // If ratio is unwieldy, use decimal
  if (rw > 20 || rh > 20) {
    return `${(w / h).toFixed(2)}:1`;
  }
  return `${rw}:${rh}`;
}

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}
