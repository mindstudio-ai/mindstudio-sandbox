/**
 * Command registry: the single place every command group is wired in.
 *
 * Explicit imports and flat literals, matching src/agentTools/index.ts — no
 * dynamic discovery, so every command is greppable from here.
 */

import type { Handler } from '../types.js';
import { requestsHandlers, requestsHelp, requestsSpecs } from './requests.js';
import { crashesHandlers, crashesHelp, crashesSpecs } from './crashes.js';
import {
  analyticsHandlers,
  analyticsHelp,
  analyticsSpecs,
} from './analytics.js';
import { releasesHandlers, releasesHelp, releasesSpecs } from './releases.js';
import {
  diagnosticsHandlers,
  diagnosticsHelp,
  diagnosticsSpecs,
} from './diagnostics.js';
import { domainsHandlers, domainsHelp, domainsSpecs } from './domains.js';
import { usersHandlers, usersHelp, usersSpecs } from './users.js';
import { dbHandlers, dbHelp, dbSpecs } from './db.js';
import { secretsHandlers, secretsHelp, secretsSpecs } from './secrets.js';
import { methodsHandlers, methodsHelp, methodsSpecs } from './methods.js';
import { dataHandlers, dataHelp, dataSpecs } from './data.js';
import { issuesHandlers, issuesHelp, issuesSpecs } from './issues.js';
import {
  prerenderHandlers,
  prerenderHelp,
  prerenderSpecs,
} from './prerender.js';
import { filesHandlers, filesHelp, filesSpecs } from './files.js';

export const SPECS = {
  ...requestsSpecs,
  ...crashesSpecs,
  ...analyticsSpecs,
  ...releasesSpecs,
  ...diagnosticsSpecs,
  ...domainsSpecs,
  ...usersSpecs,
  ...dbSpecs,
  ...secretsSpecs,
  ...methodsSpecs,
  ...dataSpecs,
  ...issuesSpecs,
  ...prerenderSpecs,
  ...filesSpecs,
};

export type CommandKey = keyof typeof SPECS;

export const HANDLERS = {
  ...requestsHandlers,
  ...crashesHandlers,
  ...analyticsHandlers,
  ...releasesHandlers,
  ...diagnosticsHandlers,
  ...domainsHandlers,
  ...usersHandlers,
  ...dbHandlers,
  ...secretsHandlers,
  ...methodsHandlers,
  ...dataHandlers,
  ...issuesHandlers,
  ...prerenderHandlers,
  ...filesHandlers,
};

/**
 * Total-coverage assertion. Each slice already checks that its own handlers
 * cover its own specs; this catches the cross-slice case — a spec key that no
 * slice claims — at compile time rather than as a runtime lookup failure.
 */
const _totalCoverage: Record<CommandKey, Handler> = HANDLERS;
void _totalCoverage;

/** Per-group help text, keyed by the group name used on the command line. */
export const GROUP_HELP: Record<string, string> = {
  requests: requestsHelp,
  crashes: crashesHelp,
  analytics: analyticsHelp,
  releases: releasesHelp,
  diagnostics: diagnosticsHelp,
  domains: domainsHelp,
  users: usersHelp,
  db: dbHelp,
  secrets: secretsHelp,
  methods: methodsHelp,
  data: dataHelp,
  issues: issuesHelp,
  prerender: prerenderHelp,
  files: filesHelp,
};
