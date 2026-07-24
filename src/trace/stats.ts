import type { AgentStats, ToolCallRecord, TraceRecord, TraceStatsSummary } from './types.js';

export function buildStats(records: TraceRecord[]): TraceStatsSummary {
  const toolCalls = dedupeToolCalls(records.filter((record): record is ToolCallRecord => record.type === 'tool_call'));
  const runId = firstValue(toolCalls.map((call) => call.run_id)) || firstValue(records.map((record) => record.run_id)) || 'unknown';
  const teamId = firstValue(toolCalls.map((call) => call.team_id).filter(Boolean));
  const agents = aggregateAgents(toolCalls);
  const byTool = aggregateTools(toolCalls);
  const sessionPaths = Array.from(new Set(records.map(recordSessionPath).filter((path): path is string => Boolean(path))));
  const starts = records.map(recordTimestamp).filter((value): value is number => value !== undefined);
  return {
    run_id: runId,
    team_id: teamId,
    agents,
    by_role_runtime: aggregateRoleRuntimes(agents),
    total_tool_calls: toolCalls.length,
    total_failed_calls: toolCalls.filter((call) => call.is_error).length,
    total_tool_duration_ms: sum(toolCalls.map((call) => call.duration_ms ?? 0)),
    wall_duration_ms: starts.length > 1 ? Math.max(...starts) - Math.min(...starts) : undefined,
    slowest: [...toolCalls].sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0)).slice(0, 5),
    by_tool: byTool,
    session_paths: sessionPaths,
  };
}

function aggregateRoleRuntimes(agents: AgentStats[]): TraceStatsSummary['by_role_runtime'] {
  const byRoleRuntime = new Map<string, TraceStatsSummary['by_role_runtime'][number]>();
  for (const agent of agents) {
    const role = agent.agent_role === 'worker' && agent.worker_role ? agent.worker_role : agent.agent_role;
    const key = `${role}:${agent.agent_kind}`;
    const current = byRoleRuntime.get(key) || { role, agent_kind: agent.agent_kind, agents: 0, calls: 0, duration_ms: 0, failed_calls: 0 };
    current.agents += 1;
    current.calls += agent.tool_calls;
    current.duration_ms += agent.tool_duration_ms;
    current.failed_calls += agent.failed_calls;
    byRoleRuntime.set(key, current);
  }
  return Array.from(byRoleRuntime.values()).sort((a, b) => a.role.localeCompare(b.role) || b.duration_ms - a.duration_ms);
}

function aggregateAgents(calls: ToolCallRecord[]): AgentStats[] {
  const byAgent = new Map<string, AgentStats>();
  for (const call of calls) {
    const key = call.agent_run_id;
    const current = byAgent.get(key) || {
      agent_run_id: call.agent_run_id,
      agent_name: call.agent_name,
      agent_kind: call.agent_kind,
      agent_role: call.agent_role,
      worker_role: call.worker_role,
      tool_calls: 0,
      failed_calls: 0,
      tool_duration_ms: 0,
    };
    current.tool_calls += 1;
    current.failed_calls += call.is_error ? 1 : 0;
    current.tool_duration_ms += call.duration_ms ?? 0;
    byAgent.set(key, current);
  }
  return Array.from(byAgent.values()).sort((a, b) => b.tool_duration_ms - a.tool_duration_ms);
}

function aggregateTools(calls: ToolCallRecord[]): TraceStatsSummary['by_tool'] {
  const byTool = new Map<string, { tool_name: string; calls: number; duration_ms: number; failed_calls: number }>();
  for (const call of calls) {
    const current = byTool.get(call.tool_name) || { tool_name: call.tool_name, calls: 0, duration_ms: 0, failed_calls: 0 };
    current.calls += 1;
    current.duration_ms += call.duration_ms ?? 0;
    current.failed_calls += call.is_error ? 1 : 0;
    byTool.set(call.tool_name, current);
  }
  return Array.from(byTool.values()).sort((a, b) => b.duration_ms - a.duration_ms);
}

function dedupeToolCalls(calls: ToolCallRecord[]): ToolCallRecord[] {
  const byId = new Map<string, ToolCallRecord>();
  for (const call of calls) {
    const key = `${call.agent_run_id}:${call.tool_call_id}`;
    const previous = byId.get(key);
    if (!previous) {
      byId.set(key, call);
    } else if (sourcePriority(call) > sourcePriority(previous)) {
      byId.set(key, call);
    } else if (sourcePriority(call) === sourcePriority(previous)) {
      byId.set(key, mergeToolCall(previous, call));
    }
  }
  return Array.from(byId.values());
}

function mergeToolCall(a: ToolCallRecord, b: ToolCallRecord): ToolCallRecord {
  const startedAt = earlier(a.started_at, b.started_at);
  const endedAt = later(a.ended_at, b.ended_at);
  const duration = endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : a.duration_ms ?? b.duration_ms;
  return {
    ...a,
    input: a.input ?? b.input,
    input_preview: a.input_preview ?? b.input_preview,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined,
    is_error: Boolean(a.is_error || b.is_error),
    session_id: a.session_id || b.session_id,
    session_path: a.session_path || b.session_path,
  };
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function sourcePriority(call: ToolCallRecord): number {
  if (call.timing_source === 'hook') return 3;
  if (call.timing_source === 'session_exact') return 2;
  return 1;
}

function recordTimestamp(record: TraceRecord): number | undefined {
  const value = record.type === 'tool_call' ? record.started_at : record.timestamp;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function recordSessionPath(record: TraceRecord): string | undefined {
  if (record.type === 'tool_call' || record.type === 'session_ref') return record.session_path;
  return undefined;
}

function firstValue(values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value));
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
