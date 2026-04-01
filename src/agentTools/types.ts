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
  readAppConfig: () => Promise<AppConfig>;
  setAppConfig: (config: AppConfig) => void;
}

export interface ExternalToolHandler {
  handle(id: string, input: Record<string, unknown>, ctx: ToolContext): boolean;
}
