import { parseJsonEvent } from '../parseJsonEvent.js';

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

// ---------------------------------------------------------------------------
// System events — unsolicited, no requestId
// ---------------------------------------------------------------------------

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
  | { event: 'platform-method-started'; id: string; method: string }
  | {
      event: 'platform-method-completed';
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
  | { event: 'connection-lost'; message: string }
  | { event: 'connection-restored' }
  | { event: 'config-changed' }
  | { event: 'config-error'; message: string }
  | { event: 'error'; message: string };

// ---------------------------------------------------------------------------
// Command responses — always have requestId + status
// ---------------------------------------------------------------------------

export interface TunnelCommandResponse {
  event: string;
  requestId: string;
  status: 'started' | 'completed';
  success?: boolean;
  error?: string;
  [key: string]: unknown;
}

export type TunnelMessage = TunnelEvent | TunnelCommandResponse;

/** Parse a stdout line as a tunnel message (system event or command response). */
export const parseTunnelMessage = (line: string) =>
  parseJsonEvent<TunnelMessage>(line);
