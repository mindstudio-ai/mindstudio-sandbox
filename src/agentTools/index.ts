import type { ExternalToolHandler } from './types.ts';
import { markBuildCompleteTool } from './tools/markBuildComplete.ts';
import { setProjectMetadataTool } from './tools/setProjectMetadata.ts';
import { runScenarioTool } from './tools/runScenario.ts';
import { runMethodTool } from './tools/runMethod.ts';
import { testJewelTool } from './tools/testJewel.ts';
import { browserCommandTool } from './tools/browserCommand.ts';
import { queryDatabaseTool } from './tools/queryDatabase.ts';

export const toolRegistry = new Map<string, ExternalToolHandler>([
  ['markBuildComplete', markBuildCompleteTool],
  ['setProjectMetadata', setProjectMetadataTool],
  ['runScenario', runScenarioTool],
  ['runMethod', runMethodTool],
  ['testJewel', testJewelTool],
  ['browserCommand', browserCommandTool],
  ['queryDatabase', queryDatabaseTool],
]);
