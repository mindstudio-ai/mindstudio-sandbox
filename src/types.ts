// WebSocket message types

export interface WsRequest {
  requestId: string;
  action: string;
  params: Record<string, unknown>;
}

export interface WsResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface WsEvent {
  event: string;
  [key: string]: unknown;
}

// Filesystem types

export interface DirEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
  /** If true, this directory should not be expanded by the frontend. */
  collapsed?: boolean;
}

export interface TreeEntry extends DirEntry {
  path: string;
  children?: TreeEntry[];
  /** If true, this directory exists but its contents are not included (e.g. node_modules). */
  collapsed?: boolean;
  /** Human-readable name from frontmatter (e.g., YAML `name` field in .md files). */
  displayName?: string;
  /** Parsed YAML frontmatter from .md files (all key-value pairs). */
  frontmatter?: Record<string, unknown>;
}

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  text: string;
}

// App config (from mindstudio.json)

export interface AppConfig {
  appId: string;
  name: string;
  description?: string;
  roles: Array<{ id: string; name: string }>;
  tables: Array<{ path: string; export: string }>;
  methods: Array<{
    id: string;
    name: string;
    description?: string;
    path: string;
    export: string;
  }>;
  interfaces: Array<{ type: string; path: string }>;
  scenarios?: Array<{
    id: string;
    name: string;
    description?: string;
    path: string;
    export: string;
    roles: string[];
  }>;
  /** Raw parsed manifest — includes any fields not in the typed interface. */
  [key: string]: unknown;
}

export interface WebConfig {
  web: {
    devCommand: string;
    devPort: number;
  };
}

// Server state

export type ServerStatus = 'bootstrapping' | 'ready' | 'error';
