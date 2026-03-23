import { SERVER_HANDLED_TOOLS } from './index.js';

/**
 * Transform remy's raw LLM-level history into frontend-friendly format.
 *
 * Raw format:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: [
 *       { type: "thinking", thinking: "...", signature: "..." },
 *       { type: "text", text: "hello" },
 *       { type: "tool_use", id: "tc_1", name: "readFile", input: {...} }
 *   ]}
 *   { role: "user", content: "result", toolCallId: "tc_1", isToolError: false }
 *
 * Transformed:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: [
 *       { type: "thinking", thinking: "...", signature: "..." },
 *       { type: "text", text: "hello" },
 *       { type: "tool", id: "tc_1", name: "readFile", input: {...}, result: "result", isError: false }
 *   ]}
 */
export function transformHistory(raw: unknown[]): unknown[] {
  // Build a map of tool results from user messages for quick lookup
  const toolResults = new Map<string, { content: string; isError: boolean }>();
  for (const msg of raw) {
    const m = msg as Record<string, unknown>;
    if (m.role === 'user' && m.toolCallId) {
      toolResults.set(m.toolCallId as string, {
        content: m.content as string,
        isError: (m.isToolError as boolean) ?? false,
      });
    }
  }

  const result: unknown[] = [];

  for (const msg of raw) {
    const m = msg as Record<string, unknown>;

    // Skip tool result messages — merged into assistant blocks
    if (m.role === 'user' && m.toolCallId) {
      continue;
    }

    // Skip internal prompts
    if (m.hidden) {
      continue;
    }

    if (m.role === 'user') {
      const userMsg: Record<string, unknown> = {
        role: 'user',
        content: m.content,
      };
      if (m.attachments) {
        userMsg.attachments = m.attachments;
      }
      result.push(userMsg);
      continue;
    }

    if (m.role === 'assistant') {
      const rawContent = m.content;

      // Handle legacy format: string content + toolCalls array
      if (typeof rawContent === 'string' || !Array.isArray(rawContent)) {
        const blocks: unknown[] = [];
        if (rawContent && typeof rawContent === 'string' && rawContent.trim()) {
          blocks.push({ type: 'text', text: rawContent });
        }
        const toolCalls = m.toolCalls as
          | Array<{
              id: string;
              name: string;
              input: unknown;
              parentToolId?: string;
            }>
          | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            if (SERVER_HANDLED_TOOLS.has(tc.name)) {
              continue;
            }
            const tr = toolResults.get(tc.id);
            blocks.push({
              type: 'tool',
              id: tc.id,
              name: tc.name,
              input: tc.input,
              result: tr?.content,
              isError: tr?.isError ?? false,
              ...(tc.parentToolId ? { parentToolId: tc.parentToolId } : {}),
            });
          }
        }
        result.push({ role: 'assistant', content: blocks });
        continue;
      }

      // New format: ordered content blocks
      const blocks: unknown[] = [];
      for (const block of rawContent as Array<Record<string, unknown>>) {
        if (block.type === 'thinking') {
          blocks.push(block);
          continue;
        }

        if (block.type === 'text') {
          if (block.text && (block.text as string).trim()) {
            blocks.push(block);
          }
          continue;
        }

        if (block.type === 'tool_use') {
          const name = block.name as string;
          if (SERVER_HANDLED_TOOLS.has(name)) {
            continue;
          }
          const id = block.id as string;
          const tr = toolResults.get(id);
          blocks.push({
            type: 'tool',
            id,
            name,
            input: block.input,
            result: tr?.content,
            isError: tr?.isError ?? false,
            ...(block.parentToolId ? { parentToolId: block.parentToolId } : {}),
            ...(block.startedAt != null ? { startedAt: block.startedAt } : {}),
          });
          continue;
        }

        // Pass through any unknown block types
        blocks.push(block);
      }

      result.push({ role: 'assistant', content: blocks });
      continue;
    }
  }

  return result;
}
