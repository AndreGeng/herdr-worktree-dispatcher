import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LatestTraceIndex, TraceIdentity } from './types.js';

export function traceRoot(): string {
  return join(process.env.TMPDIR || '/tmp', 'herdr-worktree-dispatcher-traces');
}

export function latestTraceIndexPath(): string {
  return join(traceRoot(), 'latest.json');
}

export function createTraceIdentity(input: {
  agentKind: TraceIdentity['agent_kind'];
  agentName: string;
  parentAgentRunId?: string;
  agentRole?: TraceIdentity['agent_role'];
  workerRole?: string;
  teamId?: string;
  forceNewAgentRunId?: boolean;
}): TraceIdentity {
  const now = new Date().toISOString();
  const runId = process.env.HERDR_TRACE_RUN_ID || `run_${randomId()}`;
  const teamId = input.teamId || process.env.HERDR_TRACE_TEAM_ID || undefined;
  const agentRunId = input.forceNewAgentRunId ? `agent_${randomId()}` : process.env.HERDR_TRACE_AGENT_RUN_ID || `agent_${randomId()}`;
  const agentRole = input.agentRole || parseAgentRole(process.env.HERDR_TRACE_AGENT_ROLE);
  const traceFile = join(traceRoot(), 'runs', runId, 'agents', `${agentRunId}.jsonl`);
  return {
    run_id: runId,
    team_id: teamId,
    agent_run_id: agentRunId,
    parent_agent_run_id: input.parentAgentRunId || process.env.HERDR_TRACE_PARENT_AGENT_RUN_ID || undefined,
    agent_role: agentRole,
    worker_role: input.workerRole || process.env.HERDR_TRACE_WORKER_ROLE || undefined,
    agent_kind: input.agentKind,
    agent_name: input.agentName,
    trace_file: traceFile,
    dispatch_started_at: now,
  };
}

export function writeLatestTraceIndex(index: LatestTraceIndex): void {
  const path = latestTraceIndexPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`);
}

export function ensureTraceFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function randomId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseAgentRole(value: string | undefined): TraceIdentity['agent_role'] {
  if (value === 'leader' || value === 'worker' || value === 'solo') return value;
  return 'solo';
}
