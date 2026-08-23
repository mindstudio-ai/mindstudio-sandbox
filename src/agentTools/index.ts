import type { ExternalToolHandler } from './types.js';
import { markBuildCompleteTool } from './tools/markBuildComplete.js';
import { setProjectMetadataTool } from './tools/setProjectMetadata.js';
import { runScenarioTool } from './tools/runScenario.js';
import { runMethodTool } from './tools/runMethod.js';
import { testJewelTool } from './tools/testJewel.js';
import { browserCommandTool } from './tools/browserCommand.js';
import { queryDatabaseTool } from './tools/queryDatabase.js';

export const toolRegistry = new Map<string, ExternalToolHandler>([
  ['markBuildComplete', markBuildCompleteTool],
  ['setProjectMetadata', setProjectMetadataTool],
  ['runScenario', runScenarioTool],
  ['runMethod', runMethodTool],
  ['testJewel', testJewelTool],
  ['browserCommand', browserCommandTool],
  ['queryDatabase', queryDatabaseTool],
]);
