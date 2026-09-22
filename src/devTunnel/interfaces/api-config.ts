// The API interface config, passed through verbatim.
//
// The compiled api.json has already been read: `readAppConfig` resolves each
// interface's file onto `interfaces[].config`, tolerantly. It is self-contained,
// so there is nothing to inline.

import type { AppConfig } from '../../appConfig/types.ts';

export type ApiConfigBundle = {
  name: string;
  description?: string;
  routes: Array<{
    method: string;
    path: string;
    handler: string;
    summary?: string;
    description?: string;
    tag?: string;
    params?: Record<string, unknown>;
  }>;
};

/**
 * The API interface config from the local dist files.
 *
 * @param appConfig    The parsed AppConfig
 * @returns The API config ready to send to the platform
 * @throws If no API interface is configured or the file is missing/invalid
 */
export function readApiConfig(appConfig: AppConfig): ApiConfigBundle {
  const apiInterface = appConfig.interfaces.find(
    (i) => i.type === 'api' && i.enabled !== false,
  );
  if (!apiInterface?.config) {
    throw new Error('No API interface config found');
  }
  return apiInterface.config as ApiConfigBundle;
}
