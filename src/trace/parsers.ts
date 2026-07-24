import { existsSync, readFileSync } from 'node:fs';

import { inputPreview } from './format.js';
import type { AgentKind, AgentRole, ToolCallRecord, TraceIdentity, TraceRecord } from './types.js';

interface PendingCall {
  id: string;
  toolName: string;
  input: unknown;
  startedAt: string;
}

interface ParserContext {
  identity: TraceIdentity;
  sessionPath?: string;
  sessionId?: string;
}

export function readTraceRecords(path: string): TraceRecord[] {
  if (!path || !existsSync(path)) return [];
  return parseJsonl(readFileSync(path, 'utf8')).filter(isTraceRecord);
}

export function parseSessionFallback(path: string, identity: TraceIdentity): ToolCallRecord[] {
  if (!path || !existsSync(path)) return [];
  const lines = parseJsonl(readFileSync(path, 'utf8'));
  const context: ParserContext = { identity, sessionPath: path };
  switch (identity.agent_kind) {
    case 'pi':
      return parsePiSession(lines, context);
    case 'codex':
      return parseCodexSession(lines, context);
    case 'claude':
      return parseClaudeSession(lines, context);
    case 'opencode':
      return parseOpenCodeSession(lines, context);
    default:
      return parseGenericSession(lines, context);
  }
}

export function parsePiSession(lines: unknown[], context: ParserContext): ToolCallRecord[] {
  const pending = new Map<string, PendingCall>();
  const out: ToolCallRecord[] = [];
  for (const line of lines) {
    const record = asRecord(line);
    if (!record) continue;
    if (record.type === 'session') {
      context.sessionId = stringValue(record.id) || context.sessionId;
      continue;
    }
    const message = asRecord(record.message);
    if (!message) continue;
    const timestamp = stringValue(record.timestamp) || dateFromNumeric(message.timestamp);
    if (message.role === 'assistant') {
      for (const part of arrayValue(message.content)) {
        const item = asRecord(part);
        if (!item || item.type !== 'toolCall') continue;
        const id = stringValue(item.id);
        if (!id) continue;
        pending.set(id, {
          id,
          toolName: stringValue(item.name) || 'tool',
          input: item.arguments,
          startedAt: timestamp || new Date().toISOString(),
        });
      }
    } else if (message.role === 'toolResult') {
      const id = stringValue(message.toolCallId);
      if (!id) continue;
      const start = pending.get(id);
      out.push(buildToolCall(context, {
        id,
        toolName: stringValue(message.toolName) || start?.toolName || 'tool',
        input: start?.input,
        startedAt: start?.startedAt || timestamp || new Date().toISOString(),
        endedAt: timestamp || dateFromNumeric(message.timestamp),
        isError: Boolean(message.isError),
        timingSource: 'session_exact',
      }));
    }
  }
  return out;
}

export function parseCodexSession(lines: unknown[], context: ParserContext): ToolCallRecord[] {
  const pending = new Map<string, PendingCall>();
  const out: ToolCallRecord[] = [];
  for (const line of lines) {
    const record = asRecord(line);
    if (!record) continue;
    if (record.type === 'session_meta') {
      const payload = asRecord(record.payload);
      context.sessionId = stringValue(payload?.id) || context.sessionId;
    }
    const timestamp = stringValue(record.timestamp);
    const payload = asRecord(record.payload);
    const eventType = stringValue(payload?.type);
    if (record.type === 'response_item') {
      const callId = stringValue(payload?.call_id);
      const name = stringValue(payload?.name);
      if (eventType === 'function_call' && callId) {
        pending.set(callId, {
          id: callId,
          toolName: name || 'tool',
          input: parseMaybeJson(payload?.arguments),
          startedAt: timestamp || new Date().toISOString(),
        });
      } else if (eventType === 'function_call_output' && callId) {
        const start = pending.get(callId);
        out.push(buildToolCall(context, {
          id: callId,
          toolName: start?.toolName || 'tool',
          input: start?.input,
          startedAt: start?.startedAt || timestamp || new Date().toISOString(),
          endedAt: timestamp,
          isError: false,
          timingSource: start ? 'session_exact' : 'session_estimated',
        }));
      }
    } else if (record.type === 'event_msg') {
      const callId = stringValue(payload?.call_id);
      if (!callId) continue;
      if (eventType?.endsWith('_end')) {
        const start = pending.get(callId);
        out.push(buildToolCall(context, {
          id: callId,
          toolName: toolNameFromCodexEvent(eventType) || start?.toolName || 'tool',
          input: start?.input,
          startedAt: start?.startedAt || timestamp || new Date().toISOString(),
          endedAt: timestamp,
          isError: payload?.success === false,
          timingSource: start ? 'session_exact' : 'session_estimated',
        }));
      }
    }
  }
  return out;
}

export function parseClaudeSession(lines: unknown[], context: ParserContext): ToolCallRecord[] {
  const pending = new Map<string, PendingCall>();
  const out: ToolCallRecord[] = [];
  for (const line of lines) {
    const record = asRecord(line);
    if (!record) continue;
    const timestamp = stringValue(record.timestamp) || dateFromNumeric(record.created_at);
    const message = asRecord(record.message) || record;
    const content = arrayValue(message.content);
    for (const part of content) {
      const item = asRecord(part);
      if (!item) continue;
      if (item.type === 'tool_use') {
        const id = stringValue(item.id);
        if (!id) continue;
        pending.set(id, {
          id,
          toolName: stringValue(item.name) || 'tool',
          input: item.input,
          startedAt: timestamp || new Date().toISOString(),
        });
      } else if (item.type === 'tool_result') {
        const id = stringValue(item.tool_use_id) || stringValue(item.toolUseId);
        if (!id) continue;
        const start = pending.get(id);
        out.push(buildToolCall(context, {
          id,
          toolName: start?.toolName || 'tool',
          input: start?.input,
          startedAt: start?.startedAt || timestamp || new Date().toISOString(),
          endedAt: timestamp,
          isError: Boolean(item.is_error || item.isError),
          timingSource: start ? 'session_exact' : 'session_estimated',
        }));
      }
    }
  }
  return out;
}

export function parseOpenCodeSession(lines: unknown[], context: ParserContext): ToolCallRecord[] {
  const out: ToolCallRecord[] = [];
  for (const line of lines) {
    const record = asRecord(line);
    const data = asRecord(record?.data) || record;
    if (!data || data.type !== 'tool') continue;
    const state = asRecord(data.state);
    const startedAt = stringValue(record?.created) || stringValue(record?.timestamp) || new Date().toISOString();
    const endedAt = stringValue(record?.updated) || stringValue(record?.completed) || startedAt;
    out.push(buildToolCall(context, {
      id: stringValue(data.callID) || stringValue(data.callId) || `${data.tool || 'tool'}:${out.length}`,
      toolName: stringValue(data.tool) || 'tool',
      input: state?.input,
      startedAt,
      endedAt,
      isError: state?.status === 'error',
      timingSource: startedAt === endedAt ? 'session_estimated' : 'session_exact',
    }));
  }
  return out;
}

export function parseGenericSession(lines: unknown[], context: ParserContext): ToolCallRecord[] {
  if (context.identity.agent_kind === 'unknown') return [];
  return parseClaudeSession(lines, context);
}

export function parseJsonl(contents: string): unknown[] {
  const out: unknown[] = [];
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines; session files can be appended while read.
    }
  }
  return out;
}

function buildToolCall(context: ParserContext, input: {
  id: string;
  toolName: string;
  input: unknown;
  startedAt: string;
  endedAt?: string;
  isError: boolean;
  timingSource: ToolCallRecord['timing_source'];
}): ToolCallRecord {
  const duration = input.endedAt ? Date.parse(input.endedAt) - Date.parse(input.startedAt) : undefined;
  return {
    type: 'tool_call',
    run_id: context.identity.run_id,
    team_id: context.identity.team_id,
    agent_run_id: context.identity.agent_run_id,
    parent_agent_run_id: context.identity.parent_agent_run_id,
    agent_role: context.identity.agent_role,
    worker_role: context.identity.worker_role,
    agent_kind: context.identity.agent_kind,
    agent_name: context.identity.agent_name,
    session_id: context.sessionId,
    session_path: context.sessionPath,
    tool_call_id: input.id,
    tool_name: input.toolName,
    input: input.input,
    input_preview: inputPreview(input.input),
    started_at: input.startedAt,
    ended_at: input.endedAt,
    duration_ms: duration !== undefined && Number.isFinite(duration) && duration >= 0 ? duration : undefined,
    is_error: input.isError,
    timing_source: input.timingSource,
  };
}

function isTraceRecord(value: unknown): value is TraceRecord {
  const record = asRecord(value);
  return record?.type === 'tool_call' || record?.type === 'session_ref' || record?.type === 'agent_start' || record?.type === 'agent_end' || record?.type === 'agent_spawn';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function dateFromNumeric(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolNameFromCodexEvent(eventType: string): string | undefined {
  if (eventType === 'patch_apply_end') return 'apply_patch';
  if (eventType === 'exec_command_end') return 'exec_command';
  return undefined;
}

export function inferAgentKind(command: string): AgentKind {
  const base = command.split(/\s+/)[0]?.split(/[\\/]/).pop()?.toLowerCase() || '';
  if (base.includes('pi')) return 'pi';
  if (base.includes('opencode')) return 'opencode';
  if (base.includes('claude')) return 'claude';
  if (base.includes('codex')) return 'codex';
  return 'unknown';
}

export function parseAgentRole(value: string | undefined): AgentRole {
  if (value === 'leader' || value === 'worker' || value === 'solo') return value;
  return 'solo';
}
