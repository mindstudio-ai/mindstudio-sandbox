/**
 * The editor's WS actions that relay to the tunnel. Merged into the handler
 * table at runtime (`src/index.ts`), once the process manager exists.
 */

import type { ProcessManager } from '../ProcessManager.ts';
import type { BrowserStep } from '../../devTunnel/protocol.ts';
import { createLogger } from '../../logger.ts';
import { sendCommand } from './index.ts';
import {
  startRecordingExport,
  type RecordingExportRequest,
} from './recording.ts';

const log = createLogger('tunnel');

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

/** Create WS action handlers for tunnel commands. */
export function createTunnelActions(
  pm: ProcessManager,
): Record<string, ActionHandler> {
  return {
    tunnelRunScenario: async (p) => {
      const { scenarioId, skipTruncate } = p as {
        scenarioId: string;
        skipTruncate?: boolean;
      };
      if (!scenarioId) {
        throw new Error('Missing "scenarioId" parameter');
      }
      log.info(`Running scenario: ${scenarioId}`);
      // Matches the agent-tool path's bound — seeds routinely outlive 30s,
      // and a shorter timeout reports failure while the tunnel finishes the
      // run (and its role assignment) anyway.
      return await sendCommand(
        pm,
        'run-scenario',
        { scenarioId, ...(skipTruncate ? { skipTruncate } : {}) },
        300_000,
      );
    },
    tunnelRunMethod: async (p) => {
      const { method, input, roles, userId } = p as {
        method: string;
        input?: Record<string, unknown>;
        roles?: string[];
        userId?: string;
      };
      if (!method) {
        throw new Error('Missing "method" parameter');
      }
      log.info(`Running method: ${method}`);
      return await sendCommand(
        pm,
        'run-method',
        {
          method,
          input: input ?? {},
          ...(roles ? { roles } : {}),
          ...(userId ? { userId } : {}),
        },
        30_000,
      );
    },
    tunnelBrowser: async (p) => {
      // The editor supplies these over WS, so they are unknown until checked.
      // `BrowserStep` keeps an index signature for exactly this: the tunnel
      // validates each step's `command` itself, and this side must not have to
      // grow a case per browser verb to pass one through.
      const { steps } = p as { steps?: BrowserStep[] };
      if (!steps) {
        throw new Error('Missing "steps" parameter');
      }
      return await sendCommand(pm, 'browser', { steps }, 120_000);
    },
    tunnelScreenshot: async (p) => {
      const { path } = p as { path?: string };
      return await sendCommand(
        pm,
        'screenshotFullPage',
        path ? { path } : {},
        120_000,
      );
    },
    // Set the dev test user's roles — a real write to the user's row via the
    // platform (upsert + role update + users-table sync), hence a timeout
    // sized for a platform round-trip.
    tunnelSetTestUserRoles: async (p) => {
      const { roles } = p as { roles: string[] };
      if (!Array.isArray(roles)) {
        throw new Error('Missing "roles" parameter (array of role IDs)');
      }
      log.info(`Setting test user roles: ${roles.join(', ') || '(none)'}`);
      return await sendCommand(pm, 'set-test-user-roles', { roles }, 15_000);
    },
    // Find-or-create the dev test user and return it with its current roles.
    tunnelGetTestUser: async () => {
      return await sendCommand(pm, 'get-test-user', {}, 15_000);
    },
    listDatabases: async () => {
      return await sendCommand(pm, 'list-databases', {}, 30_000);
    },
    // Render a browser-test replay to an mp4 on the box. Answers at once with
    // a jobId — the editor's request has no timeout, so the render is never
    // awaited here. Progress arrives as `recordingExportProgress`, the result
    // as `recordingExportCompleted`, and the init frame carries the status.
    tunnelExportRecording: async (p) => {
      const { jobId } = await startRecordingExport(
        pm,
        p as unknown as RecordingExportRequest,
        // A human clicked Export: refuse mid-turn, and answer with the jobId
        // rather than holding the request open for the whole render.
        { requireIdleAgent: true, awaitResult: false },
      );
      return { jobId };
    },
    tunnelCancelExportRecording: async (p) => {
      const { jobId } = p as { jobId?: string };
      if (typeof jobId !== 'string' || !jobId) {
        throw new Error('Missing "jobId" parameter');
      }
      return await sendCommand(
        pm,
        'cancel-export-recording',
        { jobId },
        15_000,
      );
    },
  };
}
