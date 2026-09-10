import { SERVER_HANDLED_TOOLS } from './index.js';

/**
 * Transform remy's history into frontend-friendly format.
 *
 * Remy's format:
 *   { role: "user", content: "hi" }
 *   { role: "assistant", content: [
 *       { type: "thinking", thinking: "...", signature: "..." },
 *       { type: "text", text: "hello", displayText?: "...", suggestions?: [...] },
 *       { type: "tool", id: "tc_1", name: "readFile", input: {...}, result: "...", isError: false }
 *   ]}
 *   { role: "user", content: "result", toolCallId: "tc_1", isToolError: false }
 *
 * What we do:
 *   1. Drop user tool-result messages (results are already on the tool blocks)
 *   2. Pass through hidden user messages (@@automated prefixed — frontend matches by sentinel)
 *   3. Drop hidden assistant messages (internal prompts)
 *   4. Filter out server-handled tools (editsFinished, markBuildComplete, etc.)
 *   5. Recurse into subAgentMessages on tool blocks
 *   6. Preserve per-message model attribution (`model`, `modelOverride`)
 *
 * Note the assistant envelope is rebuilt field-by-field rather than spread, to
 * keep remy's internal fields out of the frontend payload. Anything new that
 * needs to reach the frontend has to be added here explicitly. Content blocks
 * are the exception — they pass through whole, which is how a text block's
 * `displayText` (the copy to render, with `[label](suggest:…)` chip links
 * removed) and `suggestions` reach the editor without a change here.
 */
/**
 * Sentinels remy sweeps into a turn as hidden context rather than as anything a
 * person said or asked for. They carry no pill and no bubble, so passing them
 * through would render raw envelope markup in the transcript.
 */
const INTERNAL_SWEEP_SENTINELS = [
  '@@automated::background_results@@',
  '@@automated::workspace_status@@',
];

export function transformHistory(
  raw: unknown[],
  parentToolId?: string,
): unknown[] {
  const result: unknown[] = [];

  for (const msg of raw) {
    const m = msg as Record<string, unknown>;

    // Skip tool result messages — results are on the tool blocks
    if (m.role === 'user' && m.toolCallId) {
      continue;
    }

    // Skip hidden assistant messages (internal prompts)
    if (m.hidden && m.role !== 'user') {
      continue;
    }

    if (m.role === 'user') {
      // Hidden passive sweeps are internal plumbing — never shown. Targeted on
      // the specific sentinels rather than on `hidden`: hidden user messages in
      // general still pass through (legacy runCommand pills render off them).
      const content = m.content;
      if (
        m.hidden &&
        typeof content === 'string' &&
        INTERNAL_SWEEP_SENTINELS.some((s) => content.startsWith(s))
      ) {
        continue;
      }
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
          const resolvedParent = block.parentToolId ?? parentToolId;
          if (resolvedParent) {
            toolBlock.parentToolId = resolvedParent;
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
          // Browser-test replay references (see remy src/recording.ts). Live on
          // the block, not in `result`, so the result cap can't truncate them:
          // `recording` is this block's own chunk, `recordings` is every chunk
          // a sub-agent run recorded — kept on the spawning block because the
          // transcript cap drops the oldest steps, anchor included.
          if (block.recording != null) {
            toolBlock.recording = block.recording;
          }
          if (Array.isArray(block.recordings)) {
            toolBlock.recordings = block.recordings;
          }
          if (Array.isArray(block.subAgentMessages)) {
            toolBlock.subAgentMessages = transformHistory(
              block.subAgentMessages as unknown[],
              block.id as string,
            );
          }
          blocks.push(toolBlock);
          continue;
        }

        // Pass through any unknown block types
        blocks.push(block);
      }

      // Model attribution rides on the message envelope, so it has to be
      // copied across explicitly — this rebuild is why it used to vanish.
      // Applies to nested subagent messages too, via the recursion above:
      // those carry their own `model` and never a `modelOverride`, which is
      // what the frontend keys the override treatment off.
      const assistantMsg: Record<string, unknown> = {
        role: 'assistant',
        content: blocks,
      };
      if (m.model) {
        assistantMsg.model = m.model;
      }
      if (m.modelOverride) {
        assistantMsg.modelOverride = m.modelOverride;
      }
      result.push(assistantMsg);
      continue;
    }
  }

  return result;
}
