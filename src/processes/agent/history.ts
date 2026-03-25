import { SERVER_HANDLED_TOOLS } from './index.js';

/**
 * Transform remy's history into frontend-friendly format.
 *
 * Remy's format:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: [
 *       { type: "thinking", thinking: "...", signature: "..." },
 *       { type: "text", text: "hello" },
 *       { type: "tool", id: "tc_1", name: "readFile", input: {...}, result: "...", isError: false }
 *   ]}
 *   { role: "user", content: "result", toolCallId: "tc_1", isToolError: false }
 *
 * What we do:
 *   1. Drop user tool-result messages (results are already on the tool blocks)
 *   2. Drop hidden messages (internal prompts from runCommand)
 *   3. Filter out server-handled tools (editsFinished, setProjectOnboardingState, etc.)
 *   4. Recurse into subAgentMessages on tool blocks
 */
export function transformHistory(raw: unknown[]): unknown[] {
  const result: unknown[] = [];

  for (const msg of raw) {
    const m = msg as Record<string, unknown>;

    // Skip tool result messages — results are on the tool blocks
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

    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks: unknown[] = [];
      for (const block of m.content as Array<Record<string, unknown>>) {
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

        if (block.type === 'tool') {
          const name = block.name as string;
          if (SERVER_HANDLED_TOOLS.has(name)) {
            continue;
          }
          const toolBlock: Record<string, unknown> = {
            type: 'tool',
            id: block.id,
            name,
            input: block.input,
            result: block.result,
            isError: block.isError ?? false,
          };
          if (block.parentToolId) {
            toolBlock.parentToolId = block.parentToolId;
          }
          if (block.startedAt != null) {
            toolBlock.startedAt = block.startedAt;
          }
          if (block.completedAt != null) {
            toolBlock.completedAt = block.completedAt;
          }
          if (block.background) {
            toolBlock.background = true;
          }
          if (block.backgroundResult != null) {
            toolBlock.backgroundResult = block.backgroundResult;
          }
          if (Array.isArray(block.subAgentMessages)) {
            toolBlock.subAgentMessages = transformHistory(
              block.subAgentMessages as unknown[],
            );
          }
          blocks.push(toolBlock);
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
