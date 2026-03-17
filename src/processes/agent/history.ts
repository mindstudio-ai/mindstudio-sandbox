/**
 * Transform remy's raw LLM-level history into frontend-friendly format.
 *
 * Raw format:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: "text", toolCalls: [{id, name, input}] }
 *   { role: "user", content: "result", toolCallId: "tc_1", isToolError: false }
 *
 * Transformed:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: [
 *       { type: "text", text: "text" },
 *       { type: "tool", id: "tc_1", name: "readFile", input: {...}, result: "result", isError: false }
 *   ]}
 */
export function transformHistory(raw: unknown[]): unknown[] {
  const result: unknown[] = [];

  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i] as Record<string, unknown>;

    if (msg.role === 'user' && msg.toolCallId) {
      // Tool result — skip, already merged into preceding assistant message
      continue;
    }

    if (msg.role === 'user') {
      const userMsg: Record<string, unknown> = {
        role: 'user',
        content: msg.content,
      };
      if (msg.attachments) {
        userMsg.attachments = msg.attachments;
      }
      result.push(userMsg);
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: unknown[] = [];

      // Add text block if there's content
      if (
        msg.content &&
        typeof msg.content === 'string' &&
        msg.content.trim()
      ) {
        blocks.push({ type: 'text', text: msg.content });
      }

      // Add tool blocks, merging with subsequent tool result messages
      const toolCalls = msg.toolCalls as
        | Array<{ id: string; name: string; input: unknown }>
        | undefined;
      if (toolCalls) {
        for (const tc of toolCalls) {
          // Filter out internal-only tools
          if (tc.name === 'editsFinished') {
            continue;
          }
          let toolResult: string | undefined;
          let isError = false;
          for (let j = i + 1; j < raw.length; j++) {
            const next = raw[j] as Record<string, unknown>;
            if (next.role === 'user' && next.toolCallId === tc.id) {
              toolResult = next.content as string;
              isError = (next.isToolError as boolean) ?? false;
              break;
            }
            if (next.role !== 'user' || !next.toolCallId) {
              break;
            }
          }
          blocks.push({
            type: 'tool',
            id: tc.id,
            name: tc.name,
            input: tc.input,
            result: toolResult,
            isError,
          });
        }
      }

      result.push({ role: 'assistant', content: blocks });
      continue;
    }
  }

  return result;
}
