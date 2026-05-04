import { parseJsonEvent } from '../parseJsonEvent.js';

// ---------------------------------------------------------------------------
// Agent stdout event types
// ---------------------------------------------------------------------------

/**
 * A message sitting in remy's FIFO queue. Automated chain steps and
 * background flushes queue internally; a user message queues if the
 * sandbox forwards it while remy is busy (we gate this — see actions.ts).
 */
export interface QueuedMessage {
  command: {
    action: 'message';
    text: string;
    onboardingState?: string;
    requestId?: string;
    [key: string]: unknown;
  };
  source: 'user' | 'chain' | 'background';
  enqueuedAt: number;
}

/** System events — lifecycle; some may carry queue state on restart/resume. */
export type AgentSystemEvent =
  | { event: 'ready'; queuedMessages?: QueuedMessage[] }
  | { event: 'turn_started'; requestId?: string }
  | {
      event: 'session_restored';
      messageCount?: number;
      queuedMessages?: QueuedMessage[];
    }
  | {
      event: 'queued';
      requestId: string;
      position: number;
      queuedMessages: QueuedMessage[];
    }
  | { event: 'stopping' }
  | { event: 'stopped' };

/**
 * Turn-starting user message echoed by remy for every turn — sandbox-
 * originated (`ac-*`), chained (`chain-*`), and background (`bg-*`).
 * Rendering is driven purely by the `@@automated::X@@` prefix in `text`;
 * the `requestId` prefix indicates origin but does not affect rendering.
 */
export interface AgentUserMessageEvent {
  event: 'user_message';
  text: string;
  requestId?: string;
}

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
  | {
      event: 'history';
      messages: unknown[];
      requestId?: string;
      running?: boolean;
      currentRequestId?: string;
      queuedMessages?: QueuedMessage[];
      /** Index of messages[0] in remy's full state.messages array. */
      startIndex?: number;
      /** Exclusive upper bound — index after the last returned message. */
      endIndex?: number;
      /** Total size of remy's state.messages (full conversation length). */
      totalMessageCount?: number;
    }
  | { event: 'session_cleared'; requestId?: string }
  | {
      event: 'compaction_started';
      requestId?: string;
      /** True if the user's next turn is paused until compaction finishes. */
      blocking: boolean;
    }
  | { event: 'compaction_complete'; requestId?: string; error?: string };

/** Terminal event — exactly one per command. */
export interface AgentCompletedEvent {
  event: 'completed';
  requestId?: string;
  success: boolean;
  error?: string;
  /**
   * Items still queued when this turn ended. Non-empty → another turn is
   * starting immediately; busy state should carry across the hand-off.
   */
  queuedMessages?: QueuedMessage[];
  /**
   * On a cancel command's completed, the items drained from the queue by
   * the cancel. Typed for completeness; currently not surfaced in any UI.
   */
  cancelledMessages?: QueuedMessage[];
}

export type AgentEvent =
  | AgentSystemEvent
  | AgentStreamEvent
  | AgentDataEvent
  | AgentCompletedEvent
  | AgentUserMessageEvent;

/** Parse a stdout line as an agent event. */
export const parseAgentMessage = (line: string) =>
  parseJsonEvent<AgentEvent>(line);
