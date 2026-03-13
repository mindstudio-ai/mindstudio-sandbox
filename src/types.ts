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
}

export interface TreeEntry extends DirEntry {
  path: string;
  children?: TreeEntry[];
}

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  text: string;
}

// Process types

export type ProcessState = 'starting' | 'running' | 'crashed' | 'stopped';

export interface ManagedProcessConfig {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: boolean;
  restartOnCrash: boolean;
  maxRestarts: number;
  critical?: boolean;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}

// Tunnel event types

export interface TunnelEvent {
  event: string;
  [key: string]: unknown;
}

// App config (from mindstudio.json)

export interface AppConfig {
  appId: string;
  name: string;
  tables: Array<{ path: string; export: string }>;
  methods: Array<{ id: string; name: string; path: string; export: string }>;
  interfaces: Array<{ type: string; path: string }>;
}

export interface WebConfig {
  web: {
    devCommand: string;
    devPort: number;
  };
}

// Server state

export type ServerStatus = 'bootstrapping' | 'ready' | 'error';
