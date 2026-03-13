/**
 * Persistent sandbox state — survives hibernate/resume via filesystem snapshot.
 *
 * Written to disk on SIGTERM, restored on boot. The Vercel snapshot
 * captures the filesystem, so anything saved before shutdown is there
 * when the sandbox resumes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// --- Types ---

export interface ChatToolCall {
  type: 'tool';
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface ChatTextBlock {
  type: 'text';
  text: string;
}

export type ChatBlock = ChatTextBlock | ChatToolCall;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ChatBlock[];
}

export interface OutputLine {
  process: string;
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

interface SandboxState {
  chatHistory: ChatMessage[];
  outputLog: OutputLine[];
}

// --- In-memory state ---

const MAX_OUTPUT_LINES = 5000;

const state: SandboxState = {
  chatHistory: [],
  outputLog: [],
};

let currentBlocks: ChatBlock[] | null = null;
let statePath: string = '/tmp/sandbox-state.json';

// --- Init ---

export function initState(workspaceDir: string): void {
  statePath = path.join(workspaceDir, '.sandbox-state.json');
}

// --- Chat history ---

export function getChatHistory(): ChatMessage[] {
  return state.chatHistory;
}

export function trackUserMessage(text: string): void {
  currentBlocks = [];
  state.chatHistory.push({ role: 'user', content: text });
  state.chatHistory.push({ role: 'assistant', content: currentBlocks });
}

export function trackAgentEvent(
  eventType: string,
  data: Record<string, unknown>,
): void {
  if (!currentBlocks) {
    return;
  }

  switch (eventType) {
    case 'agentText': {
      const last = currentBlocks[currentBlocks.length - 1];
      if (last && last.type === 'text') {
        last.text += data.text as string;
      } else {
        currentBlocks.push({ type: 'text', text: data.text as string });
      }
      break;
    }
    case 'agentToolStart':
      currentBlocks.push({
        type: 'tool',
        id: data.id as string,
        name: data.name as string,
        input: data.input as Record<string, unknown>,
      });
      break;
    case 'agentToolDone': {
      const tc = currentBlocks.find(
        (b): b is ChatToolCall => b.type === 'tool' && b.id === data.id,
      );
      if (tc) {
        tc.result = data.result as string;
        tc.isError = data.isError as boolean;
      }
      break;
    }
    case 'agentTurnDone':
      currentBlocks = null;
      break;
  }
}

// --- Process output log ---

export function getOutputLog(): OutputLine[] {
  return state.outputLog;
}

export function appendOutput(
  process: string,
  stream: 'stdout' | 'stderr',
  line: string,
): void {
  state.outputLog.push({ process, stream, line, ts: Date.now() });
  // Ring buffer — drop oldest lines when full
  if (state.outputLog.length > MAX_OUTPUT_LINES) {
    state.outputLog.splice(0, state.outputLog.length - MAX_OUTPUT_LINES);
  }
}

// --- Save / Restore ---

export async function saveState(): Promise<void> {
  try {
    const json = JSON.stringify(state, null, 2);
    await fs.writeFile(statePath, json, 'utf-8');
    console.log(
      `[state] Saved (${state.chatHistory.length} chat messages, ${state.outputLog.length} output lines) → ${statePath}`,
    );
  } catch (err) {
    console.error(
      `[state] Failed to save: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export async function restoreState(): Promise<boolean> {
  try {
    const json = await fs.readFile(statePath, 'utf-8');
    const saved = JSON.parse(json) as SandboxState;
    if (saved.chatHistory) {
      state.chatHistory.push(...saved.chatHistory);
    }
    if (saved.outputLog) {
      state.outputLog.push(...saved.outputLog);
    }
    console.log(
      `[state] Restored (${state.chatHistory.length} chat messages, ${state.outputLog.length} output lines) ← ${statePath}`,
    );
    return true;
  } catch {
    console.log(`[state] No saved state found at ${statePath}`);
    return false;
  }
}
