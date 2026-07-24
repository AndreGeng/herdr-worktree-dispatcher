export type AgentKind = 'pi' | 'opencode' | 'claude' | 'codex' | 'unknown';
export type AgentRole = 'solo' | 'leader' | 'worker';
export type TimingSource = 'hook' | 'session_exact' | 'session_estimated';

export interface TraceIdentity {
  run_id: string;
  team_id?: string;
  agent_run_id: string;
  parent_agent_run_id?: string;
  agent_role: AgentRole;
  worker_role?: string;
  agent_kind: AgentKind;
  agent_name: string;
  trace_file: string;
  dispatch_started_at: string;
}

export interface LatestTraceIndex extends TraceIdentity {
  token_path?: string;
  session_path?: string;
  session_search_root?: string;
  worktree_path: string;
  branch: string;
  source_cwd: string;
}

export interface ToolCallRecord {
  type: 'tool_call';
  run_id: string;
  team_id?: string;
  agent_run_id: string;
  parent_agent_run_id?: string;
  agent_role: AgentRole;
  worker_role?: string;
  agent_kind: AgentKind;
  agent_name: string;
  session_id?: string;
  session_path?: string;
  tool_call_id: string;
  tool_name: string;
  input?: unknown;
  input_preview?: string;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  is_error?: boolean;
  timing_source: TimingSource;
}

export interface SessionRefRecord {
  type: 'session_ref';
  run_id: string;
  team_id?: string;
  agent_run_id: string;
  agent_kind: AgentKind;
  agent_name: string;
  worker_role?: string;
  session_id?: string;
  session_path?: string;
  timestamp: string;
}

export interface AgentLifecycleRecord {
  type: 'agent_start' | 'agent_end' | 'agent_spawn';
  run_id: string;
  team_id?: string;
  agent_run_id: string;
  parent_agent_run_id?: string;
  agent_role: AgentRole;
  worker_role?: string;
  agent_kind: AgentKind;
  agent_name: string;
  timestamp: string;
  child_agent_run_id?: string;
  child_agent_kind?: AgentKind;
  child_agent_name?: string;
}

export type TraceRecord = ToolCallRecord | SessionRefRecord | AgentLifecycleRecord;

export interface AgentStats {
  agent_run_id: string;
  agent_name: string;
  agent_kind: AgentKind;
  agent_role: AgentRole;
  worker_role?: string;
  tool_calls: number;
  failed_calls: number;
  tool_duration_ms: number;
}

export interface TraceStatsSummary {
  run_id: string;
  team_id?: string;
  agents: AgentStats[];
  by_role_runtime: Array<{ role: string; agent_kind: AgentKind; agents: number; calls: number; duration_ms: number; failed_calls: number }>;
  total_tool_calls: number;
  total_failed_calls: number;
  total_tool_duration_ms: number;
  wall_duration_ms?: number;
  slowest: ToolCallRecord[];
  by_tool: Array<{ tool_name: string; calls: number; duration_ms: number; failed_calls: number }>;
  session_paths: string[];
}
