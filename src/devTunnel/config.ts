/**
 * The dev tunnel's runtime configuration, read once from the environment.
 *
 * This replaces the `conf`-backed singleton the tunnel used when it was its own
 * package, which read `~/.mindstudio-local-tunnel/config.json` — a file the C&C
 * server wrote by hand, reproducing that package's schema (dead v1 fields
 * included) for a child process that now lives in this same package and is
 * spawned by absolute path. The file is gone; the C&C passes these values on the
 * child's environment instead (see `startTunnel`), which keeps the API key off
 * the command line — `ProcessManager` logs the full command and serves it to the
 * editor in the process list.
 *
 * `initConfig()` runs first, from `cli.ts`, before anything else is imported for
 * effect. Every getter throws until it has, so a boot-ordering regression is a
 * loud failure at the first call rather than an `undefined` that travels.
 *
 * @module
 */

import { parseLogLevel, type LogLevel } from './logging/logger.ts';

interface TunnelConfig {
  apiKey: string;
  apiBaseUrl: string;
  userId: string | undefined;
  dbWsUrl: string | undefined;
  logLevel: LogLevel;
}

let config: TunnelConfig | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `The dev tunnel requires ${name} in its environment. ` +
        'It is set by the C&C server when it spawns the tunnel; if you are ' +
        'running the tunnel directly, export it yourself.',
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

/**
 * Read the environment into the module-level config. Call once, first.
 *
 * `MINDSTUDIO_BASE_URL` is deliberately required with no built-in default. The
 * old `conf` schema carried `https://api.mindstudio.ai` as a per-environment
 * default, which is the shape of mistake that has a box quietly talking to
 * production because one env var went missing.
 *
 * `LOG_LEVEL` is the same variable the C&C reads, with a different fallback:
 * `info` here against its `debug`. Both feed editor-facing sinks, but two sites
 * in this process log per line rather than per event — Chrome's stderr
 * (`browser/launcher.ts`) and every completed API call including polls
 * (`api.ts`) — so inheriting the box's debug default would churn
 * `.logs/tunnel.ndjson` for nobody. Set `LOG_LEVEL=debug` on a box you are
 * debugging and both processes follow.
 */
export function initConfig(): void {
  config = {
    apiKey: required('MINDSTUDIO_API_KEY'),
    apiBaseUrl: required('MINDSTUDIO_BASE_URL'),
    userId: optional('USER_ID'),
    dbWsUrl: optional('DB_WS_URL'),
    logLevel: parseLogLevel(optional('LOG_LEVEL'), 'info'),
  };
}

function get(): TunnelConfig {
  if (!config) {
    throw new Error(
      'Dev tunnel config read before initConfig() — check the import order in cli.ts',
    );
  }
  return config;
}

export function getApiKey(): string {
  return get().apiKey;
}

export function getApiBaseUrl(): string {
  return get().apiBaseUrl;
}

export function getUserId(): string | undefined {
  return get().userId;
}

export function getLogLevel(): LogLevel {
  return get().logLevel;
}

/**
 * DB WebSocket URL, or undefined when the environment has none.
 *
 * Undefined is a MEANINGFUL answer, not a gap to paper over: the worker does
 * `if (dbWsUrl) process.env.DB_WS_URL = dbWsUrl`, so absence selects the fetch
 * transport, which addresses whatever `apiBaseUrl` this config points at. That
 * is the only correct answer when nothing has told us a socket URL — and it is
 * the normal case, because the old `writeTunnelConfig` never wrote one either,
 * so `undefined` here is what every box has always seen.
 *
 * Do NOT "fill this in for completeness" — not from a built-in constant, and
 * not derived from `apiBaseUrl`. Doing that points a box's database calls at
 * whichever API that constant names while its method dispatch — and the hook
 * token authorizing those calls — came from somewhere else entirely. The
 * symptom is `[db] invalid_authorization` on every database call from an
 * otherwise healthy box.
 */
export function getDbWsUrl(): string | undefined {
  return get().dbWsUrl;
}
