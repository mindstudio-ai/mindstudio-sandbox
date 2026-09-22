#!/usr/bin/env node
/**
 * The dev tunnel's entry point — the second bin of this package (`remy-tunnel`).
 *
 * The C&C server spawns this as a child process and talks to it over
 * stdin/stdout NDJSON (see `processes/tunnel/`). It is not spawned by name: the
 * parent resolves the built file relative to its own module, so a C&C built
 * from a branch runs the tunnel from the same tree rather than the one baked
 * into the image. Nothing else invokes this.
 *
 * No flags. Everything the C&C used to pass was either constant (it always
 * asked for the sandbox browser) or a value this process reads better itself:
 * the dev server's port comes from web.json on every session start, so an edit
 * to it reaches the proxy, and the log level from `LOG_LEVEL` like the C&C's.
 * Configuration is the inherited container environment — see `./config.ts`.
 *
 * Headless is the only mode. The interactive TUI this used to sit behind stayed
 * in the package it came from, along with the rest of the laptop story.
 *
 * @module
 */

// First, for its side effect: points the shared logger at stderr before any
// module can log. stdout is the protocol channel.
import { createLogger } from './logging/logger.ts';
import { initConfig } from './config.ts';
import { startHeadless } from './session.ts';

const log = createLogger('tunnel');

// Node's default for either is to print the stack and exit 1. Do the same, but
// as a structured line the editor's log pane can filter on rather than raw text
// the C&C has to wrap. Exiting is right: `restartOnCrash` gives this process a
// fresh start, and continuing from unknown state gives it nothing.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err: unknown) => {
    log.error(`${event}: ${err instanceof Error ? err.message : String(err)}`, {
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}

async function main(): Promise<void> {
  // First, before anything reads a getter — see ./config.ts.
  initConfig();
  await startHeadless();
}

main().catch((err: unknown) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
