import path from 'node:path';

export interface Config {
  gitRepoUrl: string;
  apiKey: string;
  userId: string;
  apiBaseUrl: string;
  callbackToken: string;
  remoteHostname: string;
  workspaceDir: string;
  port: number;
  sandboxToken: string;
}

export function loadConfig(): Config {
  const missing: string[] = [];

  function required(name: string): string {
    const val = process.env[name];
    if (!val) {
      missing.push(name);
      return '';
    }
    return val;
  }

  const config: Config = {
    gitRepoUrl: required('GIT_REPO_URL'),
    apiKey: required('API_KEY'),
    userId: required('USER_ID'),
    apiBaseUrl: process.env['API_BASE_URL'] || 'https://api.mindstudio.ai',
    callbackToken: process.env['CALLBACK_TOKEN'] || '',
    remoteHostname: process.env['REMOTE_HOSTNAME'] || '',
    workspaceDir: path.resolve(process.env['WORKSPACE_DIR'] || '/workspace'),
    port: parseInt(process.env['PORT'] || '4387', 10),
    sandboxToken: process.env['SANDBOX_TOKEN'] || '',
  };

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`,
    );
  }

  return config;
}
