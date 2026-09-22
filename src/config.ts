import {
  createLogger,
  parseLogLevel,
  setLogLevel,
  setSinkLogLevel,
  type LogLevel,
} from './logger.ts';

const log = createLogger('config');

export interface Config {
  gitRepoUrl: string;
  apiKey: string;
  appId: string;
  userId: string;
  apiBaseUrl: string;
  /** The user's computer: everything under here is what a workspace snapshot
   * persists. The workspace is inside it. */
  homeDir: string;
  workspaceDir: string;
  port: number;
  sandboxToken: string;
  /** Platform sandbox-session id, sent with every workspace-snapshot write.
   * youai-api only accepts writes from the app's newest session, so a
   * superseded box learns it has been replaced and stops. */
  sessionId: string;
  logLevel: LogLevel;
}

export function loadConfig(): Config {
  // Bootstrap log level first so all subsequent logging respects it.
  //
  // TWO levels, and the defaults differ deliberately — see logger.ts's header.
  // `debug` here is right: these entries reach the editor's log pane, which is
  // read by somebody debugging this very box. `info` for stdout is also right:
  // that sink is scraped and shipped off-box, where one debug line per agent
  // event was 57% of the whole platform's log volume.
  const rawLogLevel = process.env['LOG_LEVEL'];
  const logLevel = parseLogLevel(rawLogLevel, 'debug');
  setLogLevel(logLevel);

  const rawStdoutLevel = process.env['STDOUT_LOG_LEVEL'];
  const stdoutLogLevel = parseLogLevel(rawStdoutLevel, 'info');
  setSinkLogLevel(stdoutLogLevel);

  log.info('Loading environment variables...');
  log.info(
    `  LOG_LEVEL = ${logLevel}${rawLogLevel && rawLogLevel.toLowerCase() !== logLevel ? ` (invalid "${rawLogLevel}", using default)` : ''}`,
  );
  log.info(
    `  STDOUT_LOG_LEVEL = ${stdoutLogLevel}${rawStdoutLevel && rawStdoutLevel.toLowerCase() !== stdoutLogLevel ? ` (invalid "${rawStdoutLevel}", using default)` : ''}`,
  );

  const missing: string[] = [];

  function required(name: string): string {
    const val = process.env[name];
    if (!val) {
      log.info(`  ${name} = (MISSING)`);
      missing.push(name);
      return '';
    }
    log.debug(
      `  ${name} = ${name.includes('KEY') || name.includes('TOKEN') ? val.slice(0, 8) + '...' : val}`,
    );
    return val;
  }

  function optional(name: string, defaultVal: string): string {
    const val = process.env[name];
    const result = val || defaultVal;
    log.debug(`  ${name} = ${result}${val ? '' : ' (default)'}`);
    return result;
  }

  const sandboxToken = process.env['SANDBOX_TOKEN'] ?? '';
  if (sandboxToken) {
    log.debug(`  SANDBOX_TOKEN = ${sandboxToken.slice(0, 8)}...`);
  } else {
    log.debug('  SANDBOX_TOKEN = (not set, auth disabled)');
  }

  const config: Config = {
    gitRepoUrl: required('GIT_REPO_URL'),
    apiKey: required('MINDSTUDIO_API_KEY'),
    appId: required('MINDSTUDIO_APP_ID'),
    userId: required('USER_ID'),
    // Required with no default, and the same name every other process in the box
    // reads — the tunnel, remy, the agent SDK's codegen. A built-in
    // `https://api.mindstudio.ai` is the shape of mistake that has a box quietly
    // talking to production because one env var went missing. (This was
    // `API_BASE_URL`, a second name for the same value the platform sets both
    // of, which the children then had re-injected under the first name.)
    apiBaseUrl: required('MINDSTUDIO_BASE_URL'),
    homeDir: optional('HOME', '/home/remy'),
    // Must agree with two places outside this repo, because the editor builds every Monaco model
    // URI and the LSP `rootUri` from the same path while the language server runs with
    // `cwd: workspaceDir`. Disagreement does not error — it silently yields no completions and no
    // diagnostics for every file:
    //   youai-api  services/sandbox-images/devbox/Dockerfile           ENV WORKSPACE_DIR
    //   remy-frontend  .../CodeEditor/lspClient.ts                  WORKSPACE_ROOT
    workspaceDir: optional('WORKSPACE_DIR', '/home/remy/workspace'),
    port: parseInt(optional('PORT', '4387'), 10),
    sandboxToken,
    sessionId: required('MINDSTUDIO_SESSION_ID'),
    logLevel,
  };

  if (missing.length > 0) {
    log.error(`FATAL: Missing required env vars: ${missing.join(', ')}`);
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  log.info('Configuration loaded successfully');
  return config;
}
