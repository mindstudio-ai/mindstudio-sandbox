import { parseJsonEvent } from '../parseJsonEvent.js';

// ---------------------------------------------------------------------------
// Agent stdout event types
// ---------------------------------------------------------------------------

/** System events — no requestId, lifecycle only. */
export type AgentSystemEvent =
  | { event: 'ready' }
  | { event: 'session_restored'; messageCount?: number }
  | { event: 'stopping' }
  | { event: 'stopped' };

/** Streaming events during a command — carry requestId. */
export type AgentStreamEvent =
  | { event: 'text'; text: string; requestId?: string; parentToolId?: string }
  | {
      event: 'thinking';
      text: string;
      requestId?: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_start';
      id: string;
      name: string;
      input: Record<string, unknown>;
      partial?: boolean;
      background?: boolean;
      requestId?: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_input_delta';
      id: string;
      name: string;
      result: string;
      requestId?: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_done';
      id: string;
      name: string;
      result?: string;
      isError?: boolean;
      requestId?: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_stopped';
      id: string;
      name: string;
      mode: 'graceful' | 'hard';
      requestId?: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_restarted';
      id: string;
      name: string;
      input: Record<string, unknown>;
      requestId?: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_background_complete';
      id: string;
      name: string;
      result: string;
      requestId?: string;
    }
  | {
      event: 'status';
      message: string;
      requestId?: string;
      parentToolId?: string;
    }
  | { event: 'error'; message?: string; error?: string; requestId?: string };

/** Data events that precede a completed (carry requestId). */
export type AgentDataEvent =
  | { event: 'history'; messages: unknown[]; requestId?: string }
  | { event: 'session_cleared'; requestId?: string }
  | { event: 'compaction_complete'; requestId?: string; error?: string };

/** Terminal event — exactly one per command. */
export interface AgentCompletedEvent {
  event: 'completed';
  requestId: string;
  success: boolean;
  error?: string;
}

export type AgentEvent =
  | AgentSystemEvent
  | AgentStreamEvent
  | AgentDataEvent
  | AgentCompletedEvent;

/** Parse a stdout line as an agent event. */
export const parseAgentMessage = (line: string) =>
  parseJsonEvent<AgentEvent>(line);
