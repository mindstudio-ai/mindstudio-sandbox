/**
 * Stdin command router.
 *
 * Reads NDJSON commands from stdin and dispatches to individual handlers.
 * Every command must include a `requestId` for response correlation.
 * The router wraps handlers with automatic response framing.
 */

import { attachLineHandler } from '../../utils/lineSplitter.ts';
import { emitStarted, emitCompleted, emitUnknownAction } from '../ipc/ipc.ts';
import { createLogger } from '../logging/logger.ts';
import type { TunnelAction } from '../protocol.ts';
import { handleRunScenario } from './run-scenario.ts';
import { handleRunMethod } from './run-method.ts';
import { handleTestJewel } from './test-jewel.ts';
import { handleTestMapper } from './test-mapper.ts';
import {
  handleSetTestUserRoles,
  handleGetTestUser,
} from './test-user-roles.ts';
import { handleBrowser } from './browser.ts';
import { handleScreenshotFullPage } from './screenshot-full-page.ts';
import { handleScreenshotViewport } from './screenshot-viewport.ts';
import { handleRenderHtml } from './render-html.ts';
import { handleDevServerRestarting } from './dev-server-restarting.ts';
import { handleRestartWorker } from './restart-worker.ts';
import { handleConfigFileChanged } from './config-file-changed.ts';
import { handleTableFileChanged } from './table-file-changed.ts';
import { handleDbQuery } from './db-query.ts';
import { handleListDatabases } from './list-databases.ts';
import { handleSetupBrowser } from './setup-browser.ts';
import {
  handleExportRecording,
  handleCancelExportRecording,
} from './export-recording.ts';
import { errorCodeOf } from './types.ts';
import type {
  SessionState,
  CommandContext,
  CommandHandler,
  LifecycleHooks,
} from './types.ts';

const log = createLogger('stdin');

export type { SessionState, LifecycleHooks } from './types.ts';

/**
 * The action table, keyed by `TunnelAction` so the compiler enforces the two
 * things that used to be conventions: every action the protocol declares has a
 * handler, and every handler returns that action's declared result.
 *
 * `{ [A in TunnelAction]: CommandHandler<A> }` rather than
 * `Record<TunnelAction, CommandHandler>` — the latter would resolve the generic
 * to its default and accept any result for any action.
 */
const handlers: { [A in TunnelAction]: CommandHandler<A> } = {
  'run-method': handleRunMethod,
  'test-jewel': handleTestJewel,
  'test-mapper': handleTestMapper,
  'run-scenario': handleRunScenario,
  'set-test-user-roles': handleSetTestUserRoles,
  'get-test-user': handleGetTestUser,
  browser: handleBrowser,
  screenshotFullPage: handleScreenshotFullPage,
  screenshotViewport: handleScreenshotViewport,
  renderHtml: handleRenderHtml,
  'db-query': handleDbQuery,
  'list-databases': handleListDatabases,
  'setup-browser': handleSetupBrowser,
  'dev-server-restarting': handleDevServerRestarting,
  'restart-worker': handleRestartWorker,
  'config-file-changed': handleConfigFileChanged,
  'table-file-changed': handleTableFileChanged,
  'export-recording': handleExportRecording,
  'cancel-export-recording': handleCancelExportRecording,
};

function isTunnelAction(action: string): action is TunnelAction {
  return Object.hasOwn(handlers, action);
}

export function setupStdinCommands(
  state: SessionState,
  cwd: string,
  lifecycle: LifecycleHooks,
): void {
  if (!process.stdin.readable) {
    return;
  }

  // The same splitter the C&C reads this process's stdout with, for the same
  // reason: `readline` treats U+2028/2029 as line ends, and both are legal
  // inside a JSON string. `ProcessManager.writeStdin` escapes them for us too.
  attachLineHandler(process.stdin, (rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    let cmd: { action: string; requestId?: string; [key: string]: unknown };
    try {
      cmd = JSON.parse(line);
    } catch {
      log.warn('Invalid JSON on stdin', {
        preview: line.slice(0, 100),
      });
      return;
    }

    // Not awaited: commands run concurrently, so a session restart in flight
    // does not hold up a screenshot.
    void handleStdinCommand(cmd, state, cwd, lifecycle);
  });
}

async function handleStdinCommand(
  cmd: { action: string; requestId?: string; [key: string]: unknown },
  state: SessionState,
  cwd: string,
  lifecycle: LifecycleHooks,
): Promise<void> {
  const { requestId, action } = cmd;

  if (!requestId) {
    log.warn('Command rejected: missing requestId', { action });
    return;
  }

  if (!isTunnelAction(action)) {
    emitUnknownAction(action ?? 'unknown', requestId);
    return;
  }

  log.info('Command received', { requestId, action });

  const ctx: CommandContext = {
    state,
    cwd,
    requestId,
    lifecycle,
    started: (data) => emitStarted(action, requestId, data),
  };

  try {
    // The lookup is action-generic but this call site is not: `action` is a
    // union here, so TS cannot prove handler and result agree on ONE member of
    // it. They do agree — the `handlers` table is what guarantees that — and
    // the two casts are confined to this one dispatch.
    const handler = handlers[action] as CommandHandler;
    const result = await handler(ctx, cmd);
    log.info('Command complete', {
      requestId,
      action,
      success: result.success !== false,
    });
    emitCompleted(action, requestId, result);
  } catch (err) {
    const code = errorCodeOf(err) ?? 'INFRASTRUCTURE';
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Command failed', {
      requestId,
      action,
      error: message,
      errorCode: code,
    });
    emitCompleted(action, requestId, {
      success: false,
      error: message,
      errorCode: code,
    });
  }
}
