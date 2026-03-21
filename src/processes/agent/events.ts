export type AgentEvent =
  | { event: 'ready' }
  | { event: 'turn_started' }
  | { event: 'text'; text: string }
  | { event: 'thinking'; text: string }
  | {
      event: 'tool_start';
      id: string;
      name: string;
      input: Record<string, unknown>;
      partial?: boolean;
      parentToolId?: string;
    }
  | {
      event: 'tool_input_delta';
      id: string;
      name: string;
      result: string;
      parentToolId?: string;
    }
  | {
      event: 'tool_done';
      id: string;
      name: string;
      result?: string;
      isError?: boolean;
      parentToolId?: string;
    }
  | { event: 'turn_done' }
  | { event: 'turn_cancelled' }
  | { event: 'status'; message: string }
  | { event: 'error'; message: string }
  | { event: 'stopping' }
  | { event: 'stopped' }
  | { event: 'session_restored' }
  | { event: 'session_cleared' }
  | { event: 'history'; messages: unknown[] };

export function parseAgentLine(line: string): AgentEvent | null {
  try {
    const parsed = JSON.parse(line);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.event === 'string'
    ) {
      return parsed as AgentEvent;
    }
    return null;
  } catch {
    return null;
  }
}
