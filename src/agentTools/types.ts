import type { ProjectStatus } from '../projectStatus/ProjectStatusManager.ts';
import type {
  TunnelAction,
  TunnelCommandParams,
  TunnelCommandResult,
} from '../devTunnel/protocol.ts';

export interface ToolContext {
  sendToolResult: (id: string, result: string) => void;
  broadcast: (event: string, data: Record<string, any>) => void;
  getProjectStatus: () => ProjectStatus;
  /**
   * Generic over the action, so a tool that names `'db-query'` is checked
   * against that command's params and gets back that command's result. Every
   * tool passes a literal, so this is checked rather than merely declared.
   */
  sendTunnelCommand: <A extends TunnelAction>(
    command: A,
    params: TunnelCommandParams[A],
    timeoutMs: number,
  ) => Promise<TunnelCommandResult[A]>;
  /**
   * NOT generic, unlike `sendTunnelCommand` above — the action, its params and
   * its result are all untyped. remy's stdio protocol has no shared description:
   * its producer emits `(event: string, data?: Record<string, unknown>)` and
   * this side keeps a hand-written mirror in `processes/agent/events.ts`. Typing
   * it is its own piece of work; until then the comment above covers only the
   * tunnel command.
   */
  sendAgentCommand: (
    action: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ) => { requestId: string; response: Promise<Record<string, unknown>> };
  workspaceDir: string;
  /** Re-read `mindstudio.json` and broadcast it to the editor, after a tool wrote it. */
  refreshAppConfig: () => Promise<void>;
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
