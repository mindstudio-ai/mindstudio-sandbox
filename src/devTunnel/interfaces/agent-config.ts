// Bundle the agent interface config — inline every file it references — into
// the shape the platform runs the agent loop from.
//
// The config file itself has already been read: `readAppConfig` resolves each
// interface's file onto `interfaces[].config`, tolerantly. What is left here is
// following the paths inside it.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { extractInputSchema } from './schema/extract.ts';
import { EMPTY_OBJECT_SCHEMA } from './schema/types.ts';
import type { AppConfig } from '../../appConfig/types.ts';

export interface AgentConfigBundle {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  tools: Array<{
    name: string;
    /** 'client' = executed by the session's browser (no backend method). */
    target?: 'client';
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

/** The compiled agent config as written to disk. Paths are relative to its directory. */
type AgentConfigFile = {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  tools?: Array<{
    method?: string;
    name?: string;
    target?: string;
    description: string;
    inputSchema?: Record<string, unknown>;
  }>;
};

/**
 * Read and bundle the agent interface config from local dist files.
 *
 * @param projectRoot  Absolute path to the project root (where mindstudio.json lives)
 * @param appConfig    The parsed AppConfig (already in memory)
 * @returns The bundled agent config ready to send to the platform
 * @throws If no agent interface is configured or files are missing
 */
export function readAgentConfig(
  projectRoot: string,
  appConfig: AppConfig,
): AgentConfigBundle {
  const agentInterface = appConfig.interfaces.find(
    (i) => i.type === 'agent' && i.enabled !== false,
  );
  if (!agentInterface) {
    throw new Error('No agent interface configured in mindstudio.json');
  }
  if (!agentInterface.path) {
    throw new Error(
      'Agent interface declares no config path in mindstudio.json',
    );
  }
  // Absent when the file is missing or unparseable — "not built yet".
  if (!agentInterface.config) {
    throw new Error(
      `Agent config not found at ${agentInterface.path} — run your build command`,
    );
  }

  const config = agentInterface.config as AgentConfigFile;
  const agentDir = dirname(join(projectRoot, agentInterface.path));

  // Read and inline the system prompt
  const systemPromptPath = join(agentDir, config.systemPrompt);
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(systemPromptPath, 'utf-8');
  } catch {
    throw new Error(
      `Agent system prompt not found at ${config.systemPrompt} — run your build command`,
    );
  }

  // Read and inline each tool description + extract inputSchema from source
  const tools = (config.tools ?? []).map((tool) => {
    const descPath = join(agentDir, tool.description);
    let description: string;
    try {
      description = readFileSync(descPath, 'utf-8');
    } catch {
      throw new Error(
        `Agent tool description not found at ${tool.description} for method "${tool.method}" — run your build command`,
      );
    }

    // Use compiled inputSchema if present, otherwise extract from TS source
    let inputSchema: Record<string, unknown>;
    if (tool.inputSchema) {
      inputSchema = tool.inputSchema;
    } else {
      const method = appConfig.methods.find((m) => m.id === tool.method);
      inputSchema = method
        ? extractInputSchema(join(projectRoot, method.path), method.export)
        : EMPTY_OBJECT_SCHEMA;
    }

    return {
      name: (tool.method ?? tool.name) as string,
      ...(tool.target === 'client' ? { target: 'client' as const } : {}),
      description,
      inputSchema,
    };
  });

  return {
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    systemPrompt,
    tools,
  };
}
