import { createLogger, setLogLevel, type LogLevel } from './logger.js';

const log = createLogger('config');

const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

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
  /**
   * The branch this box BOOTS on, chosen by the platform rather than by the clone.
   *
   * Only the boot. The working tree moves afterwards — the editor's branch switcher and a plain
   * `git checkout` in the terminal both do it — and this value does not follow. Anything that needs
   * the current branch asks git (`BranchWatcher`), which is also what tells the platform.
   *
   * Never guess it from anything else at boot: the platform's session row records this value, and a
   * box that silently started somewhere else would make that record a lie without failing anywhere.
   */
  gitBranch: string;
  logLevel: LogLevel;
}

export function loadConfig(): Config {
  // Bootstrap log level first so all subsequent logging respects it
  const rawLogLevel = process.env['LOG_LEVEL']?.toLowerCase() ?? 'debug';
  const logLevel: LogLevel = VALID_LOG_LEVELS.includes(rawLogLevel as LogLevel)
    ? (rawLogLevel as LogLevel)
    : 'info';
  setLogLevel(logLevel);

  log.info('Loading environment variables...');
  log.info(
    `  LOG_LEVEL = ${logLevel}${rawLogLevel !== logLevel ? ` (invalid "${rawLogLevel}", using default)` : ''}`,
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
    apiBaseUrl: optional('API_BASE_URL', 'https://api.mindstudio.ai'),
    homeDir: optional('HOME', '/home/remy'),
    // Must agree with two places outside this repo, because the editor builds every Monaco model
    // URI and the LSP `rootUri` from the same path while the language server runs with
    // `cwd: workspaceDir`. Disagreement does not error — it silently yields no completions and no
    // diagnostics for every file:
    //   CFES  worker/Dockerfile.devbox                              ENV WORKSPACE_DIR
    //   remy-frontend  .../CodeEditor/lspClient.ts                  WORKSPACE_ROOT
    workspaceDir: optional('WORKSPACE_DIR', '/home/remy/workspace'),
    port: parseInt(optional('PORT', '4387'), 10),
    sandboxToken,
    sessionId: required('MINDSTUDIO_SESSION_ID'),
    gitBranch: required('MINDSTUDIO_GIT_BRANCH'),
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
