#!/usr/bin/env node
/**
 * The dev tunnel's entry point — the second bin of this package (`remy-tunnel`).
 *
 * The C&C server spawns this as a child process and talks to it over
 * stdin/stdout NDJSON (see `processes/tunnel/`). It is not spawned by name: the
 * parent resolves the built file relative to its own module, so a C&C built
 * from a branch runs the tunnel from the same tree rather than the one baked
 * into the image. Nothing else invokes this, so the flags below are a private
 * arrangement between two files in one package — there is no version skew to
 * tolerate, unlike the `--headless` that remy still accepts and ignores.
 *
 * Headless is the only mode. The interactive TUI this used to sit behind stayed
 * in the package it came from, along with the rest of the laptop story.
 *
 * @module
 */

import { initConfig } from './config.ts';
import { startHeadless } from './session.ts';
import type { LogLevel } from './logging/logger.ts';

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) {
    return undefined;
  }
  return process.argv[idx + 1];
}

function getNumberFlag(name: string): number | undefined {
  const raw = getFlag(name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} expects a positive integer, got "${raw}"`);
  }
  return value;
}

const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

function getLogLevel(): LogLevel | undefined {
  const raw = getFlag('--log-level');
  if (raw === undefined) {
    return undefined;
  }
  if (!LOG_LEVELS.includes(raw as LogLevel)) {
    throw new Error(
      `--log-level expects one of ${LOG_LEVELS.join(', ')}, got "${raw}"`,
    );
  }
  return raw as LogLevel;
}

async function main(): Promise<void> {
  // First, before anything reads a getter. Credentials arrive on the
  // environment rather than argv, deliberately — see ./config.ts.
  initConfig();

  await startHeadless({
    cwd: process.cwd(),
    devPort: getNumberFlag('--port'),
    proxyPort: getNumberFlag('--proxy-port'),
    logLevel: getLogLevel(),
    sandboxBrowser: process.argv.includes('--sandbox-browser'),
  });
}

main().catch((err: unknown) => {
  // stderr, not stdout: stdout is the NDJSON protocol channel and the parent
  // parses every line of it. A startup failure here is before any of that.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
