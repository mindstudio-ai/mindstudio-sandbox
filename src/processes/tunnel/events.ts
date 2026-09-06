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
  | { event: 'schema-sync-started' }
  | {
      event: 'schema-sync-completed';
      created: string[];
      altered: string[];
      errors: string[];
    }
  | { event: 'connection-lost'; message: string }
  | { event: 'connection-restored' }
  | { event: 'config-changed' }
  | { event: 'config-error'; message: string }
  | {
      event: 'sandbox-browser-state';
      state: 'starting';
      attempt: number;
      previewMode?: 'desktop' | 'mobile' | null;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'running';
      pid: number;
      previewMode?: 'desktop' | 'mobile' | null;
      viewport: string;
      executablePath: string;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'crashed';
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      consecutiveFailures: number;
      error?: string;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'restarting';
      delayMs: number;
      nextAttempt: number;
    }
  | {
      event: 'sandbox-browser-state';
      state: 'degraded';
      reason: 'repeated-crashes' | 'no-executable';
      consecutiveFailures?: number;
    }
  | { event: 'sandbox-browser-state'; state: 'stopped' }
  | {
      event: 'recording-export-progress';
      jobId: string;
      phase: 'loading' | 'rendering' | 'encoding' | 'uploading';
      percent: number;
    }
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
