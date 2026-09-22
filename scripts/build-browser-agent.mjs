/**
 * Bundle the browser agent into the single IIFE the dev proxy serves.
 *
 * `src/browserAgent/` is the in-page half of dev automation: it captures console
 * and network logs, walks the DOM for snapshots, executes click/type/select, and
 * records rrweb replays. The proxy injects a `<script>` tag into every dev-preview
 * HTML response pointing at `/__mindstudio_dev__/browser-agent.js`, which serves
 * the file this script writes.
 *
 * It used to live in its own repo, publish to npm as `@mindstudio-ai/browser-agent`,
 * and be fetched at runtime from `https://unpkg.com/.../dist/index.js` — unpinned,
 * third-party, on the critical path of all automation in every box. Nothing ever
 * imported that package; the tunnel only injected a URL and called a global, so it
 * was a served artifact rather than a dependency and had no reason to be a package.
 *
 * The settings below are a transliteration of that repo's `tsup.config.ts`, not a
 * new design — tsup is an esbuild wrapper, so calling esbuild directly with the
 * same options produces the same artifact. `bundle: true` is explicit here because
 * tsup implied it. Keep them in sync with nothing: this is now the only definition.
 *
 * `rrweb` and `@zumer/snapdom` are devDependencies deliberately — they are inlined
 * into this bundle, so the published package's runtime tree does not carry them.
 */

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { statSync } from 'node:fs';

const ENTRY = fileURLToPath(new URL('../src/browserAgent/index.ts', import.meta.url));
const OUTFILE = fileURLToPath(new URL('../dist/browserAgent/index.js', import.meta.url));

await esbuild.build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  // The page-side handle the tunnel calls over CDP. `browser/screenshot.ts` reads
  // `window.__MINDSTUDIO_BROWSER_AGENT__`, which `src/browserAgent/index.ts` assigns;
  // this name is esbuild's own wrapper for the module's exports and is separate.
  globalName: '__MindStudioBrowserAgent',
  minify: true,
  splitting: false,
  sourcemap: false,
  logLevel: 'warning',
});

const { size } = statSync(OUTFILE);
console.log(
  `build-browser-agent: ok — ${(size / 1024).toFixed(0)} KB → dist/browserAgent/index.js`,
);
