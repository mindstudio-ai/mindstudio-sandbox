/**
 * The app manifest, `mindstudio.json`, as one type for both processes.
 *
 * There were two. The C&C's was loose — an index signature, `interfaces[].path`
 * optional — because it forwards the whole object to the editor, and because
 * `path.join(dir, undefined)` once took a box down at boot. The tunnel's was
 * precise — typed `methods[].jewel`, `auth`, `dataSources` — and required the
 * very field the C&C had learned to make optional. Same file, two opinions; the
 * tunnel crashed on manifests the C&C accepted. This is the precise one with the
 * C&C's lessons applied.
 *
 * Arrays are REQUIRED and normalised by `readAppConfig` (`?? []`), so no consumer
 * writes `scenarios?.length`. `appId` is optional because the file genuinely can
 * lack it, and the tunnel reports that as its own `config-error`. The index
 * signature stays because the editor reads fields off the forwarded object
 * (`iconUrl`, `openGraphShareImageUrl`, …) that neither process has a reason to
 * type.
 *
 * @module
 */

export interface AppAuthConfig {
  enabled: boolean;
  methods: string[];
  table: {
    name: string;
    columns: Record<string, string>;
  };
}

export interface AppConfig {
  appId?: string;
  name: string;
  description?: string;
  auth?: AppAuthConfig;
  roles: AppRole[];
  tables: AppTable[];
  methods: AppMethod[];
  scenarios: AppScenario[];
  interfaces: AppInterface[];
  /** Data sources with a mapper. Sources without one are never declared. */
  dataSources: AppDataSource[];
  /** The rest of the manifest — forwarded to the editor, never read here. */
  [key: string]: unknown;
}

/** A data source whose objects go through a mapper (`<slug>.mapper.ts`). */
export interface AppDataSource {
  slug: string;
  mapper: {
    path: string;
    /** Default 'default' — a defineMapper executor. */
    export?: string;
    /** Per-object budget for `map`, in ms. Manifest parity; enforced by the executor. */
    timeoutMs?: number;
  };
}

export interface AppRole {
  id: string;
  name?: string;
  description?: string;
}

export interface AppMethod {
  id: string;
  name: string;
  description?: string;
  path: string;
  export: string;
  /** Autonomy ladder for the method's jewel. Anything past 'manual' means the
   *  jewel shadow-runs after successful human invocations. */
  autonomy?: 'manual' | 'shadow' | 'approve' | 'auto';
  /** The jewel's canary/cost dial (deployed shadowing only — testJewel never
   *  samples). Manifest parity; the tunnel doesn't enforce it. */
  sampleRate?: number;
  /** Arrival-grading window in seconds (deployed jewels.propose only).
   *  Manifest parity; the tunnel doesn't enforce it. */
  attributionWindow?: number;
  /** The method's jewel: a sibling .jewel.ts file whose export (default:
   *  'default') is a defineJewel executor. */
  jewel?: {
    path: string;
    export?: string;
    roles?: string[];
  };
}

export interface AppTable {
  path: string;
  export: string;
}

export interface AppScenario {
  id: string;
  name?: string;
  description?: string;
  path: string;
  export: string;
  roles: string[];
}

export interface AppInterface {
  type: string;
  /**
   * Path to this interface's config file, relative to the workspace.
   * Optional in the manifest schema (see remy's prompt/compiled/manifest.md):
   * an interface may carry its config inline under `config`, or declare a type
   * with nothing to configure at all (`{"type":"api"}`). Typing it as required
   * is what let `path.join(dir, undefined)` reach production.
   */
  path?: string;
  enabled?: boolean;
  /**
   * The interface's configuration: the inner object keyed by `type` from the
   * file at `path` (`web.json` → `{ "web": {…} }` → `{…}`), resolved onto the
   * manifest by `readAppConfig`; or carried inline by the manifest itself.
   */
  config?: Record<string, unknown>;
}

/** The `web` interface's config, as the dev server and the proxy need it. */
export interface WebInterfaceConfig {
  devPort?: number;
  devCommand?: string;
  /** Default preview viewport for the editor and the sandbox-owned Chrome. */
  defaultPreviewMode?: 'desktop' | 'mobile';
}
