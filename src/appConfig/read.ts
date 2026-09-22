/**
 * Reads `mindstudio.json` — the one reader for both processes.
 *
 * The C&C's reader was the hardened one: tolerant parse with JSON5 rescue,
 * repair on disk, interface configs resolved onto `interfaces[].config`. The
 * tunnel's was `JSON.parse` in a try/catch. Same file, so one trailing comma
 * from remy was a manifest the C&C accepted and repaired while the tunnel
 * rejected it — which reached the editor as `config-error: mindstudio.json is
 * invalid` from a process sitting next to one holding a good parse of it.
 *
 * `repair` decides who writes. The C&C passes true and is the only process that
 * rewrites config files; the tunnel passes false and gets the same tolerant
 * read without becoming a second writer racing the first on the same path.
 *
 * @module
 */

import path from 'node:path';
import { createLogger } from '../logger.ts';
import { loadJsonConfigFile } from '../utils/jsonConfig.ts';
import type {
  AppConfig,
  AppDataSource,
  AppInterface,
  WebInterfaceConfig,
} from './types.ts';

const log = createLogger('app-config');

/** The manifest as parsed, before normalisation: every typed field may be absent. */
type RawManifest = Partial<AppConfig>;

function isMappedDataSource(value: unknown): value is AppDataSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { slug?: unknown }).slug === 'string' &&
    typeof (value as { mapper?: { path?: unknown } }).mapper?.path === 'string'
  );
}

/**
 * Read and normalise the manifest, resolving each interface's config file onto
 * `interfaces[].config`. Null when there is no manifest, it does not parse, or
 * it is not an app manifest (no `name`) — the callers all have a degraded path
 * for that and log why.
 */
export async function readAppConfig(
  workspaceDir: string,
  opts: { repair: boolean },
): Promise<AppConfig | null> {
  const manifestPath = path.join(workspaceDir, 'mindstudio.json');
  log.debug(`Reading app config from ${manifestPath}`);

  // The repair, when enabled, happens inside this call — i.e. BEFORE the
  // interface-resolution loop below mutates `iface.config`. Writing after that
  // point would persist the resolved interface blobs back into mindstudio.json.
  const result = await loadJsonConfigFile<RawManifest>(manifestPath, {
    normalize: opts.repair,
  });
  if (!result.ok) {
    if (result.notFound) {
      log.error(`App config not found at ${manifestPath}`);
    } else {
      log.error(`Failed to parse app config: ${result.error}`);
    }
    return null;
  }
  const parsed = result.value;
  if (typeof parsed.name !== 'string' || !parsed.name) {
    log.error('mindstudio.json has no "name" — not an app manifest');
    return null;
  }

  // Spread first so the manifest's untyped fields travel with it (the editor
  // reads them); then pin every array the two processes index into.
  const config: AppConfig = {
    ...parsed,
    name: parsed.name,
    roles: parsed.roles ?? [],
    tables: parsed.tables ?? [],
    methods: parsed.methods ?? [],
    scenarios: parsed.scenarios ?? [],
    interfaces: parsed.interfaces ?? [],
    dataSources: Array.isArray(parsed.dataSources)
      ? parsed.dataSources.filter(isMappedDataSource)
      : [],
  };

  log.info('Loaded mindstudio.json', {
    appId: config.appId,
    name: config.name,
    methods: config.methods.length,
    tables: config.tables.length,
    interfaces: config.interfaces.map((i) => i.type).join(',') || 'none',
    scenarios: config.scenarios.length,
    dataSources: config.dataSources.length,
  });

  // Resolve interface configs — read each config file and extract the inner
  // object keyed by type (e.g. web.json → { "web": {...} } → {...}). Mirrors the
  // deploy pipeline's readManifestFromRepo behavior.
  for (const iface of config.interfaces) {
    // An entry with no path has no file to resolve — either its config is inline
    // under `config` (already carried by the parsed manifest, so leaving it
    // untouched is correct), or the type has nothing to configure at all.
    // Skipping matches the pipeline this loop mirrors, which logs and continues.
    //
    // This was fatal rather than cosmetic: `path.join(dir, undefined)` throws,
    // and the throw escaped the null-return contract into main()'s catch, so one
    // absent optional field on one interface took the whole sandbox down at
    // bootstrap instead of reaching the degraded mode the caller already
    // handles. The not-found branch below has always tolerated the file being
    // absent; only the field itself was unguarded.
    if (!iface.path) {
      log.debug(`  ${iface.type} declares no config path — nothing to resolve`);
      continue;
    }
    const configPath = path.join(workspaceDir, iface.path);
    const ifaceResult = await loadJsonConfigFile<Record<string, unknown>>(
      configPath,
      { normalize: opts.repair },
    );
    if (!ifaceResult.ok) {
      if (ifaceResult.notFound) {
        log.debug(`  ${iface.type} config not found at ${iface.path}`);
      } else {
        // Previously silent: an unparseable web.json fell through to the
        // default devCommand/devPort, which can silently point the tunnel at
        // the wrong port.
        log.warn(
          `  ${iface.type} config at ${iface.path} is unparseable: ${ifaceResult.error}`,
        );
      }
      continue;
    }
    const inner = ifaceResult.value[iface.type];
    if (inner && typeof inner === 'object') {
      iface.config = inner as Record<string, unknown>;
      log.debug(`  ${iface.type} config resolved from ${iface.path}`);
    }
  }

  return config;
}

/**
 * The enabled `web` interface, if the manifest declares one. `enabled: false`
 * is how a manifest keeps an interface's files around without running it, so
 * every consumer — dev server, proxy, sandbox Chrome — must agree to skip it.
 */
export function findWebInterface(config: AppConfig): AppInterface | null {
  return (
    config.interfaces.find((i) => i.type === 'web' && i.enabled !== false) ??
    null
  );
}

/**
 * The `web` interface's config, typed. Reads the blob `readAppConfig` already
 * resolved rather than the file again — so a `web.json` that needed the JSON5
 * rescue is read tolerantly here too, once.
 */
export function getWebInterfaceConfig(
  config: AppConfig,
): WebInterfaceConfig | null {
  const web = findWebInterface(config)?.config;
  if (!web) {
    return null;
  }
  return {
    devPort: typeof web.devPort === 'number' ? web.devPort : undefined,
    devCommand: typeof web.devCommand === 'string' ? web.devCommand : undefined,
    defaultPreviewMode:
      web.defaultPreviewMode === 'mobile'
        ? 'mobile'
        : web.defaultPreviewMode === 'desktop'
          ? 'desktop'
          : undefined,
  };
}
