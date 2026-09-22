/**
 * Cross-origin font fixer.
 *
 * Cross-origin font stylesheets can't be read via CSSOM, which prevents
 * SnapDOM from discovering and embedding @font-face rules in screenshots.
 *
 * Fix: rewrite cross-origin stylesheet URLs to go through our local proxy
 * at /__mindstudio_dev__/font-proxy?url=... which fetches the stylesheet
 * server-side and serves it as same-origin. The proxy also rewrites font
 * URLs inside the CSS to go through itself, so the actual .woff2 files
 * are also same-origin accessible.
 *
 * This runs once on init and also observes dynamically-added font links.
 */

import { getState } from './state';

/**
 * Check if a link element is a cross-origin stylesheet that needs proxying.
 */
function needsFix(link: HTMLLinkElement): boolean {
  if (link.dataset.fontProxied) {
    return false;
  } // already handled
  if (!link.rel || !link.rel.includes('stylesheet')) {
    return false;
  }
  const href = link.href || '';
  try {
    const url = new URL(href);
    return url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Replace a cross-origin stylesheet link with one that goes through our proxy.
 */
function fixLink(link: HTMLLinkElement): void {
  const proxyUrl = `/__mindstudio_dev__/font-proxy?url=${encodeURIComponent(link.href)}`;

  const newLink = document.createElement('link');
  newLink.rel = 'stylesheet';
  newLink.href = proxyUrl;
  newLink.dataset.fontProxied = 'true';

  if (link.media) {
    newLink.media = link.media;
  }

  newLink.onload = () => {
    link.remove();
  };
  newLink.onerror = () => {
    // Proxy failed — remove broken copy, keep original
    newLink.remove();
  };

  link.parentNode?.insertBefore(newLink, link.nextSibling);
}

/**
 * Scan the document for cross-origin font links and fix them.
 */
function fixExistingLinks(): void {
  const links = document.querySelectorAll<HTMLLinkElement>(
    'link[rel~="stylesheet"]',
  );
  for (const link of links) {
    if (needsFix(link)) {
      fixLink(link);
    }
  }
}

/**
 * Watch for dynamically-added font links and fix them on the fly.
 */
function observeNewLinks(): void {
  const s = getState().fonts;
  if (s.observer) {
    return;
  }
  s.observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLLinkElement && needsFix(node)) {
          fixLink(node);
        }
      }
    }
  });
  s.observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * Check if a URL is a cross-origin font/stylesheet resource.
 */
function isCrossOriginFontUrl(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin === window.location.origin) {
      return false;
    }
    // Common font CDN patterns — CSS stylesheets and font binary files
    if (/\.(css|woff2?|ttf|otf|eot)(\?|$)/i.test(parsed.pathname)) {
      return true;
    }
    if (parsed.pathname.includes('/css')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Patch window.fetch to route cross-origin font/stylesheet requests
 * through our proxy. This catches direct fetches from SnapDOM that
 * bypass the <link> tag rewriting.
 */
function patchFetch(): void {
  if ((window.fetch as any).__ms_font_proxied) {
    return;
  }

  const originalFetch = window.fetch;

  window.fetch = function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url || String(input);

    if (isCrossOriginFontUrl(url)) {
      const proxied = `/__mindstudio_dev__/font-proxy?url=${encodeURIComponent(url)}`;
      return originalFetch.apply(this, [proxied, init] as Parameters<
        typeof fetch
      >);
    }

    return originalFetch.apply(this, [input, init] as Parameters<typeof fetch>);
  };
  (window.fetch as any).__ms_font_proxied = true;
}

/**
 * Initialize the font fixer. Safe to call multiple times.
 */
export function initFontFixer(): void {
  const s = getState().fonts;
  if (s.initialized) {
    return;
  }
  s.initialized = true;
  patchFetch();
  fixExistingLinks();
  observeNewLinks();
}

/**
 * Ensure all font links have been fixed and fonts are loaded.
 * Call before screenshot capture for best results.
 */
export async function ensureFontsReady(): Promise<void> {
  fixExistingLinks();
  try {
    await document.fonts.ready;
  } catch {
    // Font loading API not available or errored
  }
}
