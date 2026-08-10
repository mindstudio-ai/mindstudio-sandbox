import { createLogger, setLogLevel, type LogLevel } from './logger.js';

const log = createLogger('config');

const VALID_LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface Config {
  gitRepoUrl: string;
  apiKey: string;
  userId: string;
  apiBaseUrl: string;
  workspaceDir: string;
  port: number;
  sandboxToken: string;
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
    userId: required('USER_ID'),
    apiBaseUrl: optional('API_BASE_URL', 'https://api.mindstudio.ai'),
    workspaceDir: '/home/vercel-sandbox/workspace',
    port: parseInt(optional('PORT', '4387'), 10),
    sandboxToken,
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
