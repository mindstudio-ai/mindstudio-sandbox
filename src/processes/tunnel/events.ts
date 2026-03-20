export interface TunnelRole {
  id: string;
  name: string;
  description?: string;
}

export interface TunnelScenario {
  id: string;
  name: string;
  description?: string;
  path: string;
  roles: string[];
}

export type TunnelEvent =
  | { event: 'session-starting'; appId: string; name: string }
  | {
      event: 'session-started';
      sessionId: string;
      releaseId: string;
      branch: string;
      proxyPort: number | null;
      proxyUrl: string | null;
      webInterfaceUrl: string;
      roles: TunnelRole[];
      scenarios: TunnelScenario[];
    }
  | { event: 'session-stopping' }
  | { event: 'session-stopped' }
  | { event: 'session-expired' }
  | { event: 'method-started'; id: string; method: string }
  | {
      event: 'method-completed';
      id: string;
      success: boolean;
      duration: number;
      error?: string;
    }
  | { event: 'scenario-started'; id: string; name: string }
  | {
      event: 'scenario-completed';
      id: string;
      success: boolean;
      duration: number;
      roles: string[];
      error?: string;
    }
  | { event: 'schema-sync-started' }
  | {
      event: 'schema-sync-completed';
      created: string[];
      altered: string[];
      errors: string[];
    }
  | { event: 'impersonation-changed'; roles: string[] | null }
  | {
      event: 'method-run-completed';
      method: string;
      success: boolean;
      output: unknown | null;
      error: {
        message: string;
        stack?: string;
        code?: string;
        statusCode?: number;
        status?: number;
        response?: string;
        body?: string;
        cause?: unknown;
      } | null;
      stdout: string[];
      duration: number;
    }
  | {
      event: 'browser-completed';
      id: string;
      steps: Array<{
        index: number;
        command: string;
        result: string;
        error?: string;
      }>;
      snapshot: string;
      duration: number;
    }
  | { event: 'connection-lost'; message: string }
  | { event: 'connection-restored' }
  | { event: 'config-changed' }
  | { event: 'config-error'; message: string }
  | { event: 'command-error'; message: string }
  | { event: 'error'; message: string };

export function parseTunnelLine(line: string): TunnelEvent | null {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.event === 'string'
    ) {
      return parsed as TunnelEvent;
    }
    return null;
  } catch {
    return null;
  }
}
