import type { Args } from './args.js';

/**
 * A command implementation. The registry in `commands/index.ts` holds one per
 * spec key.
 *
 * Handlers that need no arguments declare `(appId: string)` and remain
 * assignable here by structural typing — no need to accept an unused parameter.
 */
export type Handler = (appId: string, a: Args) => Promise<void>;
