/**
 * Dev server process — manages the frontend dev server (Vite, webpack, etc.).
 *
 * Pure generic process — no custom event parsing or WS actions.
 * stdout/stderr are captured automatically by the process registry.
 */

import type { ProcessManager } from '../ProcessManager.js';
import { createLogger } from '../../logger.js';

const log = createLogger('dev-server');

export function startDevServer(
  pm: ProcessManager,
  config: { command: string; cwd: string },
): void {
  const [cmd, ...args] = config.command.split(' ');
  log.info(`Starting: ${config.command} in ${config.cwd}`);
  pm.start({
    name: 'devServer',
    command: cmd,
    args,
    cwd: config.cwd,
    restartOnCrash: true,
    maxRestarts: 5,
  });
}
