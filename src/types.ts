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
}

export interface SearchResult {
  file: string;
  line: number;
  column: number;
  text: string;
}

// Process types

export type ProcessType = 'service' | 'task' | 'shell' | 'system';
export type ProcessState =
  | 'starting'
  | 'running'
  | 'crashed'
  | 'stopped'
  | 'completed';

export interface ProcessLogEntry {
  stream: 'stdout' | 'stderr';
  line: string;
  ts: number;
}

export interface RestartRecord {
  at: number;
  exitCode: number | null;
  signal: string | null;
}

export interface ProcessResourceMetrics {
  rss: number | null; // Resident set size in bytes
  heapUsed: number | null; // JS heap used (main process only)
  heapTotal: number | null; // JS heap total (main process only)
  cpu: number | null; // CPU usage 0-100 since last sample
}

export interface SystemResourceMetrics {
  timestamp: number;
  container: {
    memoryLimit: number | null; // cgroup limit in bytes (null if unknown)
    memoryUsage: number | null; // cgroup current usage in bytes
    memoryPercent: number | null;
  };
  processes: Record<string, ProcessResourceMetrics>;
}

export interface ProcessInfo {
  name: string;
  type: ProcessType;
  command: string;
  state: ProcessState;
  startedAt: number | null;
  endedAt: number | null;
  duration: number | null;
  exitCode: number | null;
  signal: string | null;
  restartCount: number;
  restartHistory: RestartRecord[];
  pid: number | null;
}

export interface ProcessStateChangeEvent {
  name: string;
  type: ProcessType;
  prevState: ProcessState;
  state: ProcessState;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number | null;
  restartCount?: number;
  timestamp: number;
}

export interface ProcessSnapshot {
  info: ProcessInfo;
  log: ProcessLogEntry[];
}

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

// Editor state

export interface EditorTab {
  path: string;
  isPreview: boolean;
}

export interface EditorState {
  tabs: EditorTab[];
  activeTab: string | null;
  expandedDirs: string[];
}

// Agent activity

export type AgentFileAction = 'reading' | 'writing' | 'editing';

export interface AgentActivity {
  activeFile: string | null;
  action: AgentFileAction | null;
  toolCallId: string | null;
}

// Server state

export type ServerStatus = 'bootstrapping' | 'ready' | 'error';
