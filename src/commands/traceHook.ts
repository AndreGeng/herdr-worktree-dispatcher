import { appendFileSync, readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { inputPreview } from '../trace/format.js';
import { ensureTraceFile } from '../trace/paths.js';
import { inferAgentKind, parseAgentRole } from '../trace/parsers.js';
import type { AgentKind, TraceRecord } from '../trace/types.js';

interface TraceHookOptions {
  event?: string;
  agent?: string;
}

export function registerTraceHook(program: Command): void {
  program
    .command('trace-hook')
    .description('Internal command. Append agent hook events to trace JSONL')
    .requiredOption('--event <name>', 'Hook event name')
    .option('--agent <name>', 'Agent kind override')
    .action((options: TraceHookOptions) => runTraceHook(options));
}

export function runTraceHook(options: TraceHookOptions): void {
  const traceFile = process.env.HERDR_TRACE_FILE;
  if (!traceFile) return;
  const stdin = readStdin();
  const payload = parsePayload(stdin);
  const record = buildRecord(options.event || '', options.agent, payload);
  if (!record) return;
  ensureTraceFile(traceFile);
  appendFileSync(traceFile, `${JSON.stringify(record)}\n`);
}

function buildRecord(event: string, agentOverride: string | undefined, payload: Record<string, unknown>): TraceRecord | undefined {
  const now = new Date().toISOString();
  const agentKind = parseAgentKind(agentOverride || process.env.HERDR_TRACE_AGENT_KIND || '');
  const base = {
    run_id: process.env.HERDR_TRACE_RUN_ID || 'run_unknown',
    team_id: process.env.HERDR_TRACE_TEAM_ID || undefined,
    agent_run_id: process.env.HERDR_TRACE_AGENT_RUN_ID || 'agent_unknown',
    parent_agent_run_id: process.env.HERDR_TRACE_PARENT_AGENT_RUN_ID || undefined,
    agent_role: parseAgentRole(process.env.HERDR_TRACE_AGENT_ROLE),
    worker_role: process.env.HERDR_TRACE_WORKER_ROLE || undefined,
    agent_kind: agentKind,
    agent_name: process.env.HERDR_TRACE_AGENT_NAME || 'agent',
  };
  if (isSessionStart(event)) {
    return {
      type: 'session_ref',
      run_id: base.run_id,
      team_id: base.team_id,
      agent_run_id: base.agent_run_id,
      agent_kind: base.agent_kind,
      agent_name: base.agent_name,
      worker_role: base.worker_role,
      session_id: stringValue(payload.session_id) || stringValue(payload.sessionId) || stringValue(payload.id),
      session_path: stringValue(payload.session_path) || stringValue(payload.sessionPath) || stringValue(payload.transcript_path),
      timestamp: now,
    };
  }
  if (isStartEvent(event)) {
    return {
      type: 'tool_call',
      ...base,
      session_id: stringValue(payload.session_id) || stringValue(payload.sessionId),
      session_path: stringValue(payload.session_path) || stringValue(payload.sessionPath),
      tool_call_id: toolCallId(payload),
      tool_name: toolName(payload),
      input: toolInput(payload),
      input_preview: inputPreview(toolInput(payload)),
      started_at: now,
      timing_source: 'hook',
    };
  }
  if (isEndEvent(event)) {
    const endedAt = now;
    return {
      type: 'tool_call',
      ...base,
      session_id: stringValue(payload.session_id) || stringValue(payload.sessionId),
      session_path: stringValue(payload.session_path) || stringValue(payload.sessionPath),
      tool_call_id: toolCallId(payload),
      tool_name: toolName(payload),
      input: toolInput(payload),
      input_preview: inputPreview(toolInput(payload)),
      started_at: stringValue(payload.started_at) || endedAt,
      ended_at: endedAt,
      is_error: Boolean(payload.is_error || payload.isError || payload.error),
      timing_source: 'hook',
    };
  }
  if (isAgentStart(event) || isAgentEnd(event)) {
    return {
      type: isAgentStart(event) ? 'agent_start' : 'agent_end',
      ...base,
      timestamp: now,
    };
  }
  return undefined;
}

function readStdin(): string {
  try {
    return process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseAgentKind(value: string): AgentKind {
  const inferred = inferAgentKind(value);
  return inferred === 'unknown' && (value === 'pi' || value === 'opencode' || value === 'claude' || value === 'codex') ? value : inferred;
}

function toolCallId(payload: Record<string, unknown>): string {
  return stringValue(payload.tool_call_id) || stringValue(payload.toolCallId) || stringValue(payload.call_id) || stringValue(payload.callId) || `${toolName(payload)}:${Date.now()}`;
}

function toolName(payload: Record<string, unknown>): string {
  return stringValue(payload.tool_name) || stringValue(payload.toolName) || stringValue(payload.name) || stringValue(payload.tool) || 'tool';
}

function toolInput(payload: Record<string, unknown>): unknown {
  return payload.tool_input ?? payload.toolInput ?? payload.input ?? payload.args ?? payload.arguments;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isSessionStart(event: string): boolean {
  return normalize(event) === 'sessionstart' || normalize(event) === 'session_start';
}

function isStartEvent(event: string): boolean {
  const normalized = normalize(event);
  return normalized === 'pretooluse' || normalized === 'tool_execution_start' || normalized === 'tool_call_start';
}

function isEndEvent(event: string): boolean {
  const normalized = normalize(event);
  return normalized === 'posttooluse' || normalized === 'tool_execution_end' || normalized === 'tool_call_end';
}

function isAgentStart(event: string): boolean {
  const normalized = normalize(event);
  return normalized === 'agent_start' || normalized === 'userpromptsubmit';
}

function isAgentEnd(event: string): boolean {
  const normalized = normalize(event);
  return normalized === 'agent_end' || normalized === 'stop';
}

function normalize(event: string): string {
  return event
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]/g, '_')
    .toLowerCase();
}
