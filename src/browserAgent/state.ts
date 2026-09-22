/**
 * Centralized mutable state — all runtime state lives on window.__ms
 * so it survives HMR module replacement.
 *
 * Every module with mutable state imports getState() and reads/writes
 * its own namespace (e.g. getState().cursor, getState().ws).
 */

import type { LogEntry } from './protocol';

export interface MsState {
  ws: {
    ws: WebSocket | null;
    clientId: string | null;
    reconnectDelay: number;
    closing: boolean;
    busy: boolean;
  };
  cursor: {
    el: HTMLDivElement | null;
    rippleEl: HTMLDivElement | null;
    x: number;
    y: number;
    hasPosition: boolean;
    hideTimer: ReturnType<typeof setTimeout> | null;
    executing: boolean;
    targetElement: Element | null;
    trackingFrame: number | null;
    moveTimer: ReturnType<typeof setTimeout> | null;
    settledResolve: (() => void) | null;
    visibilityState:
      | 'hidden'
      | 'visible'
      | 'fading-in'
      | 'fading-out'
      | 'force-visible'
      | 'force-hidden'
      | 'snapshot-hidden';
    preSnapshotState:
      | 'hidden'
      | 'visible'
      | 'fading-in'
      | 'fading-out'
      | 'force-visible'
      | 'force-hidden'
      | null;
  };
  snapshot: {
    refCounter: number;
    refMap: Map<string, Element>;
  };
  networkIdle: {
    activeRequests: number;
  };
  transport: {
    buffer: LogEntry[];
    flushTimer: ReturnType<typeof setTimeout> | null;
    capturing: boolean;
    captured: LogEntry[];
    wsGetter: (() => WebSocket | null) | null;
  };
  messages: {
    handler: ((e: MessageEvent) => void) | null;
  };
  nav: {
    lastUrl: string | null;
  };
  screenshot: {
    capturing: boolean;
  };
  fonts: {
    initialized: boolean;
    observer: MutationObserver | null;
  };
  zoom: {
    pipMode: boolean;
    mobilePreview: boolean;
  };
  touch: {
    circleEl: HTMLDivElement | null;
    active: boolean;
    pressed: boolean;
    dragging: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    onMouseMove: ((e: MouseEvent) => void) | null;
    onMouseDown: ((e: MouseEvent) => void) | null;
    onMouseUp: (() => void) | null;
    onMouseLeave: (() => void) | null;
    onDragStart: ((e: Event) => void) | null;
    momentumFrame: number | null;
    overscrollY: number;
    bouncing: boolean;
    bounceTimer: ReturnType<typeof setTimeout> | null;
    scrollContainer: HTMLElement | null;
    velocityX: number;
    velocityY: number;
    lastMoveTime: number;
  };
  mirror: {
    recording: boolean;
    stopFn: (() => void) | null;
  };
  sessionRecording: {
    active: boolean;
    runId: string | null;
    stopFn: (() => void) | null;
    buffer: unknown[];
  };
  authCredsWidget: {
    initialized: boolean;
    host: HTMLDivElement | null;
    observer: MutationObserver | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    awaitingCode: boolean;
    awaitingCodeTimer: ReturnType<typeof setTimeout> | null;
    codePollTimer: ReturnType<typeof setInterval> | null;
    codeAttempts: number;
    codeSubmitted: boolean;
    codeSeenCount: number;
    blankPolls: number;
  };
}

const KEY = '__ms' as const;
const RECONNECT_BASE = 1000;

function createDefaults(): MsState {
  return {
    ws: {
      ws: null,
      clientId: null,
      reconnectDelay: RECONNECT_BASE,
      closing: false,
      busy: false,
    },
    cursor: {
      el: null,
      rippleEl: null,
      x: -100,
      y: -100,
      hasPosition: false,
      hideTimer: null,
      executing: false,
      targetElement: null,
      trackingFrame: null,
      moveTimer: null,
      settledResolve: null,
      visibilityState: 'hidden',
      preSnapshotState: null,
    },
    snapshot: { refCounter: 0, refMap: new Map() },
    networkIdle: { activeRequests: 0 },
    transport: {
      buffer: [],
      flushTimer: null,
      capturing: false,
      captured: [],
      wsGetter: null,
    },
    messages: { handler: null },
    nav: { lastUrl: null },
    screenshot: { capturing: false },
    fonts: { initialized: false, observer: null },
    zoom: { pipMode: false, mobilePreview: false },
    touch: {
      circleEl: null,
      active: false,
      pressed: false,
      dragging: false,
      startX: 0,
      startY: 0,
      lastX: 0,
      lastY: 0,
      onMouseMove: null,
      onMouseDown: null,
      onMouseUp: null,
      onMouseLeave: null,
      onDragStart: null,
      momentumFrame: null,
      overscrollY: 0,
      bouncing: false,
      bounceTimer: null,
      scrollContainer: null,
      velocityX: 0,
      velocityY: 0,
      lastMoveTime: 0,
    },
    mirror: {
      recording: false,
      stopFn: null,
    },
    sessionRecording: {
      active: false,
      runId: null,
      stopFn: null,
      buffer: [],
    },
    authCredsWidget: {
      initialized: false,
      host: null,
      observer: null,
      debounceTimer: null,
      awaitingCode: false,
      awaitingCodeTimer: null,
      codePollTimer: null,
      codeAttempts: 0,
      codeSubmitted: false,
      codeSeenCount: 0,
      blankPolls: 0,
    },
  };
}

/**
 * Get the global mutable state object. Lazily initializes on first call.
 * Survives HMR because it lives on `window`, not in module scope.
 */
export function getState(): MsState {
  const w = window as any;
  if (!w[KEY]) {
    w[KEY] = createDefaults();
  }
  return w[KEY];
}
