// Bundle the MCP interface config — inline its file references — into the shape
// the platform serves as the app's MCP server in dev.
//
// The config file itself has already been read: `readAppConfig` resolves each
// interface's file onto `interfaces[].config`, tolerantly. What is left here is
// following the paths inside it.
//
// Unlike api.json (self-contained, passed through verbatim), the MCP
// interface.json references three things by path that must be inlined:
//   - instructions       -> contents of the instructions file
//   - tools[].description -> contents of each tools/*.md
//   - prompts[].template  -> contents of each prompts/*.md
// Everything else (name, method, tool name/title/annotations, resources,
// prompt arguments) passes through verbatim. Input schemas are NOT computed
// here — the platform resolves each tool's schema from the method contract.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppConfig } from '../../appConfig/types.ts';

export interface McpToolConfig {
  method: string;
  name: string;
  title?: string;
  description: string; // inlined from tools/*.md
  annotations?: Record<string, unknown>;
}

export interface McpResourceConfig {
  method: string;
  uri?: string;
  uriTemplate?: string;
  name: string;
  mimeType?: string;
}

export interface McpPromptConfig {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; required?: boolean }>;
  template: string; // inlined from prompts/*.md
}

export interface McpConfigBundle {
  name: string;
  instructions: string; // inlined from the instructions file
  tools: McpToolConfig[];
  resources: McpResourceConfig[];
  prompts: McpPromptConfig[];
}

/** The compiled MCP config as written to disk: same shape as the bundle, but
 *  `instructions`, `tools[].description` and `prompts[].template` are paths. */
type McpConfigFile = {
  instructions?: string;
  tools?: McpToolConfig[];
  prompts?: McpPromptConfig[];
  resources?: McpResourceConfig[];
  [key: string]: unknown;
};

/**
 * Read and bundle the MCP interface config from local dist files.
 *
 * @param projectRoot  Absolute path to the project root (where mindstudio.json lives)
 * @param appConfig    The parsed AppConfig (already in memory)
 * @returns The bundled MCP config ready to send to the platform
 * @throws If no MCP interface is configured or a referenced file is missing
 */
export function readMcpConfig(
  projectRoot: string,
  appConfig: AppConfig,
): McpConfigBundle {
  const mcpInterface = appConfig.interfaces.find(
    (i) => i.type === 'mcp' && i.enabled !== false,
  );
  if (!mcpInterface) {
    throw new Error('No MCP interface configured in mindstudio.json');
  }
  if (!mcpInterface.path) {
    throw new Error('MCP interface declares no config path in mindstudio.json');
  }
  // Absent when the file is missing or unparseable — "not built yet".
  if (!mcpInterface.config) {
    throw new Error(
      `MCP config not found at ${mcpInterface.path} — run your build command`,
    );
  }

  const config = mcpInterface.config as McpConfigFile;
  const mcpDir = dirname(join(projectRoot, mcpInterface.path));

  // Resolve a file referenced (by relative path) from the interface dir and
  // inline its contents. A listed-but-missing file is a broken build.
  const readRef = (rel: string, label: string): string => {
    try {
      return readFileSync(join(mcpDir, rel), 'utf-8');
    } catch {
      throw new Error(
        `MCP ${label} not found at ${rel} — run your build command`,
      );
    }
  };

  // instructions is optional; inline it only when the interface declares one.
  const instructions = config.instructions
    ? readRef(config.instructions, 'instructions')
    : '';

  // Inline each tool's description; pass method/name/title/annotations verbatim.
  const tools: McpToolConfig[] = (config.tools ?? []).map((tool) => ({
    ...tool,
    description: readRef(
      tool.description,
      `tool description for "${tool.method}"`,
    ),
  }));

  // Inline each prompt's template; pass name/title/description/arguments verbatim.
  const prompts: McpPromptConfig[] = (config.prompts ?? []).map((prompt) => ({
    ...prompt,
    template: readRef(prompt.template, `prompt template for "${prompt.name}"`),
  }));

  return {
    ...config,
    instructions,
    tools,
    prompts,
    resources: config.resources ?? [],
  } as McpConfigBundle;
}
