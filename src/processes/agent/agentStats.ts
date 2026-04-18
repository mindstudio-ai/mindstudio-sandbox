/**
 * Read remy's `.remy-stats.json` — per-turn stats file used to drive
 * compaction UI and context-size hints on the frontend.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export interface AgentStats {
  messageCount: number;
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  lastContextSize: number;
  compactionInProgress: boolean;
  updatedAt: number;
}

export async function readAgentStats(
  workspaceDir: string,
): Promise<AgentStats | null> {
  try {
    const content = await fs.readFile(
      path.join(workspaceDir, '.remy-stats.json'),
      'utf-8',
    );
    return JSON.parse(content) as AgentStats;
  } catch {
    return null;
  }
}
