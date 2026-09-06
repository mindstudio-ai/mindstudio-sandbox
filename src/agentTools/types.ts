import type { ProjectStatus } from '../projectStatus/ProjectStatusManager.js';
import type { AppConfig } from '../types.js';

export interface ToolContext {
  sendToolResult: (id: string, result: string) => void;
  broadcast: (event: string, data: Record<string, any>) => void;
  getProjectStatus: () => ProjectStatus;
  sendTunnelCommand: (
    command: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<Record<string, unknown>>;
  sendAgentCommand: (
    action: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => { requestId: string; response: Promise<Record<string, unknown>> };
  workspaceDir: string;
  readAppConfig: () => Promise<AppConfig | null>;
  setAppConfig: (config: AppConfig) => void;
  /**
   * Fired once, on the genuine first transition into the `buildComplete`
   * onboarding state. The implementation (wired in index.ts) snapshots the
   * workspace (which carries the manifest's display fields to the platform)
   * then POSTs youai-api's initial-build-complete email. Fire-and-forget.
   */
  onInitialBuildComplete: () => void;
}

export interface ExternalToolHandler {
  handle(id: string, input: Record<string, unknown>, ctx: ToolContext): boolean;
}
