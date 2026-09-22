/**
 * Workspace change notifications — the C&C's watcher telling the tunnel.
 *
 * The watcher fires once per chokidar event, and a build rewrites many files
 * in a burst. These coalesce a burst into one command — trailing-edge, with
 * the 500 ms the tunnel's own watchers used before this replaced them. A
 * failure is logged and dropped on purpose: the tunnel re-reads everything on
 * each session start, so a notification it never received is caught up on the
 * next one.
 */

import type { ProcessManager } from '../ProcessManager.ts';
import { createLogger } from '../../logger.ts';
import { sendCommand } from './index.ts';

const log = createLogger('tunnel');

const NOTIFY_DEBOUNCE_MS = 500;
/** A full session restart on a slow platform — teardown, `/manage/start`, schema sync. */
const NOTIFY_TIMEOUT_MS = 60_000;

let configFileChangedTimer: ReturnType<typeof setTimeout> | null = null;
let tableFileChangedTimer: ReturnType<typeof setTimeout> | null = null;

function warnIfNotApplied(
  action: 'config-file-changed' | 'table-file-changed',
  result: { success: boolean; error?: string },
): void {
  if (!result.success) {
    log.warn(`Tunnel did not act on ${action}: ${result.error}`);
  }
}

/** `mindstudio.json`, or an interface config it references, changed. */
export function notifyConfigFileChanged(
  pm: ProcessManager,
  absPath: string,
): void {
  if (configFileChangedTimer) {
    clearTimeout(configFileChangedTimer);
  }
  configFileChangedTimer = setTimeout(() => {
    configFileChangedTimer = null;
    void sendCommand(
      pm,
      'config-file-changed',
      { path: absPath },
      NOTIFY_TIMEOUT_MS,
    ).then((result) => warnIfNotApplied('config-file-changed', result));
  }, NOTIFY_DEBOUNCE_MS);
}

/** A declared table source file changed. */
export function notifyTableFileChanged(pm: ProcessManager): void {
  if (tableFileChangedTimer) {
    clearTimeout(tableFileChangedTimer);
  }
  tableFileChangedTimer = setTimeout(() => {
    tableFileChangedTimer = null;
    void sendCommand(pm, 'table-file-changed', {}, NOTIFY_TIMEOUT_MS).then(
      (result) => warnIfNotApplied('table-file-changed', result),
    );
  }, NOTIFY_DEBOUNCE_MS);
}
