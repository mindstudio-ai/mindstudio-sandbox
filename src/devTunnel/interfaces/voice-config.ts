// Bundle the voice interface config — inline every file it references — into
// the shape the platform runs a voice session from.
//
// The config file itself has already been read: `readAppConfig` resolves each
// interface's file onto `interfaces[].config`, tolerantly. What is left here is
// following the paths inside it.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { extractInputSchema } from './schema/extract.ts';
import { EMPTY_OBJECT_SCHEMA } from './schema/types.ts';
import type { AppConfig } from '../../appConfig/types.ts';

export interface VoiceToolBundle {
  method: string;
  /** 'client' = executed by the session's browser (no backend method). */
  target?: 'client';
  latency?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface VoiceConfigBundle {
  name?: string;
  description?: string;
  /**
   * Engine, key-discriminated: {model, voice} for native speech-to-speech,
   * or {llm, stt, tts, voice} for a cascaded pipeline.
   */
  model?: Record<string, unknown>;
  turnDetection?: Record<string, unknown>;
  greeting?: string;
  webInterfacePath?: string;
  systemPrompt: string;
  tools: VoiceToolBundle[];
  [key: string]: unknown;
}

/** The compiled voice config as written to disk. Paths are relative to its directory. */
type VoiceConfigFile = {
  systemPrompt?: string;
  tools?: Array<{
    method?: string;
    name?: string;
    target?: string;
    latency?: string;
    description: string;
    inputSchema?: Record<string, unknown>;
  }>;
  [key: string]: unknown;
};

/**
 * Read and bundle the voice interface config from local dist files.
 *
 * Unknown config keys are passed through (spread), so model-specific
 * settings and future fields survive without a tunnel release.
 *
 * @param projectRoot  Absolute path to the project root (where mindstudio.json lives)
 * @param appConfig    The parsed AppConfig (already in memory)
 * @returns The bundled voice config ready to send to the platform
 * @throws If no voice interface is configured or files are missing
 */
export function readVoiceConfig(
  projectRoot: string,
  appConfig: AppConfig,
): VoiceConfigBundle {
  const voiceInterface = appConfig.interfaces.find(
    (i) => i.type === 'voice' && i.enabled !== false,
  );
  if (!voiceInterface) {
    throw new Error('No voice interface configured in mindstudio.json');
  }
  if (!voiceInterface.path) {
    throw new Error(
      'Voice interface declares no config path in mindstudio.json',
    );
  }
  // Absent when the file is missing or unparseable — "not built yet".
  if (!voiceInterface.config) {
    throw new Error(
      `Voice config not found at ${voiceInterface.path} — run your build command`,
    );
  }

  const config = voiceInterface.config as VoiceConfigFile;
  const voiceDir = dirname(join(projectRoot, voiceInterface.path));

  // Read and inline the system prompt
  const systemPromptPath = config.systemPrompt;
  if (!systemPromptPath) {
    throw new Error('Voice config missing "systemPrompt" field');
  }
  let systemPrompt: string;
  try {
    systemPrompt = readFileSync(join(voiceDir, systemPromptPath), 'utf-8');
  } catch {
    throw new Error(
      `Voice system prompt not found at ${config.systemPrompt} — run your build command`,
    );
  }

  // Read and inline each tool description + extract inputSchema from source
  const tools: VoiceToolBundle[] = (config.tools ?? []).map((tool) => {
    const descPath = join(voiceDir, tool.description);
    let description: string;
    try {
      description = readFileSync(descPath, 'utf-8');
    } catch {
      throw new Error(
        `Voice tool description not found at ${tool.description} for method "${tool.method}" — run your build command`,
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
      method: (tool.method ?? tool.name) as string,
      ...(tool.target === 'client' ? { target: 'client' as const } : {}),
      latency: tool.latency,
      description,
      inputSchema,
    };
  });

  return {
    ...config,
    systemPrompt,
    tools,
  };
}
