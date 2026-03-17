/**
 * Derived project capability flag.
 *
 * projectHasCode is true when the manifest declares methods or
 * interfaces — meaning compiled code exists in dist/. Derived from
 * the manifest, not scanned from disk.
 *
 * When projectHasCode is false, remy only has spec tools.
 * When projectHasCode is true, remy has spec + code tools.
 */

import type { AppConfig } from '../../../types.js';
import { createLogger } from '../../../logger.js';

const log = createLogger('project-phase');

/**
 * Derive projectHasCode from the app manifest.
 * Returns true if methods or interfaces are declared.
 */
export function getProjectHasCode(appConfig: AppConfig): boolean {
  return (
    (appConfig.methods?.length ?? 0) > 0 ||
    (appConfig.interfaces?.length ?? 0) > 0
  );
}
