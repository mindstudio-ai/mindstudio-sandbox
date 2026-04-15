import type { ExternalToolHandler } from './types.js';
import { setProjectOnboardingStateTool } from './tools/setProjectOnboardingState.js';
import { setProjectMetadataTool } from './tools/setProjectMetadata.js';
import { runScenarioTool } from './tools/runScenario.js';
import { runMethodTool } from './tools/runMethod.js';
import { browserCommandTool } from './tools/browserCommand.js';
import { queryDatabaseTool } from './tools/queryDatabase.js';

export const toolRegistry = new Map<string, ExternalToolHandler>([
  ['setProjectOnboardingState', setProjectOnboardingStateTool],
  ['setProjectMetadata', setProjectMetadataTool],
  ['runScenario', runScenarioTool],
  ['runMethod', runMethodTool],
  ['browserCommand', browserCommandTool],
  ['queryDatabase', queryDatabaseTool],
]);
