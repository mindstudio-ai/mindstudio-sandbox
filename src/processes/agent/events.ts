import { parseJsonEvent } from '../parseJsonEvent.js';

// ---------------------------------------------------------------------------
// Agent stdout event types
// ---------------------------------------------------------------------------

/**
 * A message sitting in remy's FIFO queue. `source:'user'` is an intentional
 * mid-turn user send — the sandbox now forwards user messages while remy is
 * busy and they queue instead of being rejected (see actions.ts). `chain` and
 * `background` are system items remy enqueues internally.
 *
 * Cancellable via cancelQueued: `user` items, and `chain` items that are `held`
 * — a build pipeline paused by a Stop. Both carry `command.requestId`; a held
 * chain item can only be removed by passing that id explicitly.
 */
export interface QueuedMessage {
  command: {
    // Usually 'message'; a mid-turn /compact queues as action 'compact'
    // with an @@automated::compact@@ display text.
    action: string;
    text: string;
    onboardingState?: string;
    requestId?: string;
    [key: string]: unknown;
  };
  source: 'user' | 'chain' | 'background';
  enqueuedAt: number;
  /** Delivery semantics. 'asap' — promoted via agentSetQueuedDelivery — is
   * injected into the running turn at its next tool boundary; 'afterTurn'
   * (default, also when absent) waits for the turn to end. While remy is idle,
   * promoting moves the item to the head and runs it. Only plain user items
   * are promotable. */
  delivery?: 'asap' | 'afterTurn';
  /**
   * Waiting on the user, not on the agent — remy will not deliver this on its
   * own. Set on the user messages that survive a cancel, on user messages
   * restored from disk after a remy restart, and on the `chain` steps of a build
   * pipeline a Stop paused. Sending a new message releases all of it (the
   * pipeline goes behind that message); promoting releases one user item; the X
   * discards.
   *
   * Held items are deliberately excluded from derived busy and from
   * resume-on-restart: nothing here runs until the user acts.
   */
  held?: boolean;
}

/**
 * Per-agent model picks for a session. Sparse — any omitted key falls
 * back to remy's server default for that agent. Absence of the whole
 * `models` field means "defaults everywhere." Keys are agent identifiers
 * (parent, visualDesignExpert, etc.); values are remy-allow-listed
 * model IDs. Validation lives in remy — bad IDs surface as an
 * `invalid_model_override` error event.
 */
export type AgentModels = Record<string, string>;

/**
 * One pickable (or unpickable) surface in remy's model registry. Remy
 * ships the full registry on every session_restored and history payload
 * so the frontend can drive the picker from the wire instead of
 * hardcoded constants. `default` is authoritative — when the user
 * hasn't picked, remy uses this. `userPickable: false` surfaces should
 * be hidden from the picker (today: only imagePromptEnhancer).
 */
export interface ModelSurface {
  default: string;
  label: string;
  description?: string;
  /** 'text' | 'vision' | 'image_generation' — kept open for forward-compat. */
  modelType: string;
  userPickable: boolean;
}

/**
 * The full model registry. Key order is meaningful — JSON preserves it
 * and remy uses it as the desired picker order, so the frontend should
 * iterate via Object.keys (not Object.entries with sort) when rendering.
 */
export type ModelSurfaces = Record<string, ModelSurface>;

/**
 * Per-modelType allow-list. Keys present → constrained (frontend can
 * only show these IDs). Keys absent → unconstrained (frontend curates
 * from its own catalog). Today only `text` is constrained; `vision`
 * and `image_generation` are absent.
 */
export type AllowedModelsByType = Record<string, string[]>;

/**
 * Marks a turn/message that ran on a build-override model ("Build with X")
 * rather than the user's normal default. `from` is the default it diverged
 * from. Present only for build-driven overrides — a user changing their own
 * default mid-session is a deliberate choice and is intentionally unmarked,
 * so the frontend keys the override treatment off this field's presence
 * rather than comparing `model` against the default.
 */
export interface ModelOverride {
  from: string;
}

/** System events — lifecycle. */
export type AgentSystemEvent =
  | { event: 'ready' }
  | {
      event: 'turn_started';
      requestId?: string;
      /** Model executing this turn. */
      model?: string;
      /** Set when a build override put this turn on a non-default model. */
      modelOverride?: ModelOverride;
    }
  | {
      event: 'session_restored';
      messageCount?: number;
      /** Per-agent model picks active on the restored session. */
      models?: AgentModels;
      /** Full picker registry — always present from current remy. */
      modelSurfaces?: ModelSurfaces;
      /** Sparse per-type allow-list — always present from current remy. */
      allowedModelsByType?: AllowedModelsByType;
    }
  | {
      /**
       * Live queue-state event — emitted on every queue mutation (user message
       * queued, chain/background enqueued, item shifted out to run, or a cancel/
       * cancelQueued removal). No requestId. `queuedMessages` is always the full
       * current snapshot, including [] when the queue empties — reconcile to it,
       * don't track deltas. Replaces the removed `queued` event.
       */
      event: 'queue_changed';
      queuedMessages: QueuedMessage[];
    }
  | { event: 'stopping' }
  | { event: 'stopped' };

/**
 * User message echoed by remy as it enters a turn — sandbox-originated
 * (`ac-*`), chained (`chain-*`), and background (`bg-*`/`background-*`).
 * A merged turn (contiguous queued user messages + background results
 * delivered together) emits one of these per absorbed message, each with
 * its own original `requestId` and `queued: true`.
 */
export interface AgentUserMessageEvent {
  event: 'user_message';
  text: string;
  requestId?: string;
  /** Attachments riding on the message (voice transcript, images, files) —
   * the live event's parity with get_history, so queued sends render fully. */
  attachments?: unknown[];
  /** True when the message was delivered from remy's queue rather than sent
   * while the agent was idle. The frontend renders queued echoes (idle sends
   * are rendered optimistically at send time instead). ASAP-promoted messages
   * injected mid-turn also arrive with `queued: true`. */
  queued?: boolean;
  /** True for internal entries the frontend must not render — e.g. the
   * hidden background_results sweep that delivers passive background tool
   * outcomes (specSync) at the start of a turn. */
  hidden?: boolean;
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
  | {
      event: 'error';
      message?: string;
      error?: string;
      requestId?: string;
      /**
       * Structured error classifier from remy. Known value today:
       * 'invalid_model_override' — accompanied by `badModelId` pointing
       * at the rejected pick. Other codes may appear over time; treat
       * as opaque and surface to the FE verbatim.
       */
      code?: string;
      badModelId?: string;
    };

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
      /** Per-agent model picks active on the session (sparse; absent = all defaults). */
      models?: AgentModels;
      /** Full picker registry — always present from current remy. */
      modelSurfaces?: ModelSurfaces;
      /** Sparse per-type allow-list — always present from current remy. */
      allowedModelsByType?: AllowedModelsByType;
    }
  | {
      event: 'models_changed';
      requestId?: string;
      /** Per-agent model picks now active (sparse; absent = all defaults). */
      models?: AgentModels;
      /** Full picker registry (same shape as history/session_restored). */
      modelSurfaces?: ModelSurfaces;
      /** Sparse per-type allow-list. */
      allowedModelsByType?: AllowedModelsByType;
    }
  | { event: 'session_cleared'; requestId?: string }
  | {
      event: 'compaction_started';
      requestId?: string;
      /** True if the user's next turn is paused until compaction finishes. */
      blocking: boolean;
    }
  | { event: 'compaction_complete'; requestId?: string; error?: string };

/**
 * Terminal event — exactly one per command. When remy merges contiguous
 * queued messages into one turn, the turn's primary requestId gets the real
 * completed first, then each other absorbed requestId gets one completed
 * with the same outcome and `absorbed: true` immediately after. Absorbed
 * terminals resolve their pending command but carry no turn lifecycle —
 * busy/endTurn/activity handling belongs to the primary alone.
 */
export interface AgentCompletedEvent {
  event: 'completed';
  requestId?: string;
  success: boolean;
  error?: string;
  /** True for a merged-away requestId's synthetic terminal (see above). */
  absorbed?: boolean;
  /**
   * On a `cancel` command's completed, the background follow-ups dropped by the
   * stop (they were context for the turn being killed). Typed for completeness;
   * not surfaced in any UI.
   */
  cancelledMessages?: QueuedMessage[];
  /**
   * On a `cancel` command's completed, the items the stop left in the queue
   * held. Typed for completeness; the queue card renders the authoritative
   * snapshot from queue_changed instead.
   */
  heldMessages?: QueuedMessage[];
  /**
   * On a `cancel` command's completed: this stop paused a build pipeline — the
   * interrupted step plus the remaining steps are held in remy's queue and
   * resume on the user's next send. Absent on an older remy, which destroyed the
   * remainder instead; that absence is exactly what agentCancel branches on to
   * decide whether to drop the project out of onboarding.
   */
  pausedPipeline?: boolean;
  /**
   * On a `cancelQueued` command's completed, the pending user messages removed
   * (the matched items; [] if nothing matched).
   */
  cancelledQueued?: QueuedMessage[];
  /**
   * The model that actually served the request. Useful for confirming a
   * changeModels pick took effect and for a "running on X" debug banner.
   */
  modelId?: string;
  /**
   * Per-turn usage stats from the provider. Schema is provider-agnostic
   * for the fields we surface; cacheReadTokens now available on both
   * Anthropic and OpenAI. Pass-through — frontend owns rendering.
   */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    [key: string]: unknown;
  };
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
