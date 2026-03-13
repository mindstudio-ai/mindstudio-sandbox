import path from 'node:path';

export interface Config {
  gitRepoUrl: string;
  apiKey: string;
  userId: string;
  apiBaseUrl: string;
  workspaceDir: string;
  port: number;
  sandboxToken: string;
}

export function loadConfig(): Config {
  console.log('[config] Loading environment variables...');

  const missing: string[] = [];

  function required(name: string): string {
    const val = process.env[name];
    if (!val) {
      console.log(`[config]   ${name} = (MISSING)`);
      missing.push(name);
      return '';
    }
    console.log(`[config]   ${name} = ${name.includes('KEY') || name.includes('TOKEN') ? val.slice(0, 8) + '...' : val}`);
    return val;
  }

  function optional(name: string, defaultVal: string): string {
    const val = process.env[name];
    const result = val || defaultVal;
    console.log(`[config]   ${name} = ${result}${val ? '' : ' (default)'}`);
    return result;
  }

  const config: Config = {
    gitRepoUrl: required('GIT_REPO_URL'),
    apiKey: required('API_KEY'),
    userId: required('USER_ID'),
    apiBaseUrl: optional('API_BASE_URL', 'https://api.mindstudio.ai'),
    workspaceDir: path.resolve(optional('WORKSPACE_DIR', '/workspace')),
    port: parseInt(optional('PORT', '4387'), 10),
    sandboxToken: process.env['SANDBOX_TOKEN']
      ? (console.log(`[config]   SANDBOX_TOKEN = ${process.env['SANDBOX_TOKEN']!.slice(0, 8)}...`), process.env['SANDBOX_TOKEN']!)
      : (console.log('[config]   SANDBOX_TOKEN = (not set, auth disabled)'), ''),
  };

  if (missing.length > 0) {
    console.error(`[config] FATAL: Missing required env vars: ${missing.join(', ')}`);
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  console.log('[config] Configuration loaded successfully');
  return config;
}
