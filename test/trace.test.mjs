import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findLatestPiSessionForWorktree } from '../dist/trace/piSessions.js';
import { createTraceIdentity } from '../dist/trace/paths.js';
import { parseCodexSession, parseJsonl, parsePiSession } from '../dist/trace/parsers.js';
import { buildStats } from '../dist/trace/stats.js';

const identity = {
  run_id: 'run_1',
  team_id: 'team_1',
  agent_run_id: 'agent_1',
  agent_role: 'worker',
  worker_role: 'reviewer',
  agent_kind: 'pi',
  agent_name: 'wt-test',
  trace_file: '/tmp/trace.jsonl',
  dispatch_started_at: '2026-07-02T00:00:00.000Z',
};

test('parses Pi tool calls from session JSONL', () => {
  const lines = parseJsonl([
    JSON.stringify({ type: 'session', id: 'ses_pi', timestamp: '2026-07-02T00:00:00.000Z', cwd: '/tmp/work' }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-07-02T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'npm test' } }] },
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2026-07-02T00:00:03.500Z',
      message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', isError: false, content: [] },
    }),
  ].join('\n'));
  const calls = parsePiSession(lines, { identity, sessionPath: '/tmp/pi.jsonl' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_name, 'bash');
  assert.equal(calls[0].duration_ms, 2500);
  assert.equal(calls[0].session_id, 'ses_pi');
  assert.equal(calls[0].input_preview, 'npm test');
});

test('parses Codex function calls from rollout JSONL', () => {
  const codexIdentity = { ...identity, agent_kind: 'codex', agent_name: 'wt-codex' };
  const lines = parseJsonl([
    JSON.stringify({ type: 'session_meta', timestamp: '2026-07-02T00:00:00.000Z', payload: { id: 'ses_codex' } }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-02T00:00:01.000Z',
      payload: { type: 'function_call', call_id: 'call_2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git status' }) },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: '2026-07-02T00:00:02.250Z',
      payload: { type: 'function_call_output', call_id: 'call_2', output: 'ok' },
    }),
  ].join('\n'));
  const calls = parseCodexSession(lines, { identity: codexIdentity, sessionPath: '/tmp/codex.jsonl' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool_name, 'exec_command');
  assert.equal(calls[0].duration_ms, 1250);
  assert.equal(calls[0].session_id, 'ses_codex');
  assert.equal(calls[0].input_preview, 'git status');
});

test('stats aggregates team agents and merges hook start/end records', () => {
  const records = [
    {
      type: 'tool_call',
      run_id: 'run_1',
      team_id: 'team_1',
      agent_run_id: 'leader_1',
      agent_role: 'leader',
      agent_kind: 'claude',
      agent_name: 'leader',
      tool_call_id: 'call_a',
      tool_name: 'bash',
      input_preview: 'pnpm test',
      started_at: '2026-07-02T00:00:00.000Z',
      timing_source: 'hook',
    },
    {
      type: 'tool_call',
      run_id: 'run_1',
      team_id: 'team_1',
      agent_run_id: 'leader_1',
      agent_role: 'leader',
      agent_kind: 'claude',
      agent_name: 'leader',
      tool_call_id: 'call_a',
      tool_name: 'bash',
      started_at: '2026-07-02T00:00:00.000Z',
      ended_at: '2026-07-02T00:00:05.000Z',
      timing_source: 'hook',
    },
    {
      type: 'tool_call',
      run_id: 'run_1',
      team_id: 'team_1',
      agent_run_id: 'worker_1',
      agent_role: 'worker',
      worker_role: 'reviewer',
      agent_kind: 'pi',
      agent_name: 'worker',
      tool_call_id: 'call_b',
      tool_name: 'read',
      started_at: '2026-07-02T00:00:01.000Z',
      ended_at: '2026-07-02T00:00:03.000Z',
      duration_ms: 2000,
      is_error: true,
      timing_source: 'session_exact',
    },
    {
      type: 'tool_call',
      run_id: 'run_1',
      team_id: 'team_1',
      agent_run_id: 'worker_2',
      agent_role: 'worker',
      worker_role: 'reviewer',
      agent_kind: 'codex',
      agent_name: 'worker-codex',
      tool_call_id: 'call_c',
      tool_name: 'read',
      started_at: '2026-07-02T00:00:01.000Z',
      ended_at: '2026-07-02T00:00:04.000Z',
      duration_ms: 3000,
      timing_source: 'session_exact',
    },
  ];
  const summary = buildStats(records);
  assert.equal(summary.team_id, 'team_1');
  assert.equal(summary.agents.length, 3);
  assert.equal(summary.agents.find((agent) => agent.agent_run_id === 'worker_1')?.worker_role, 'reviewer');
  assert.equal(summary.total_tool_calls, 3);
  assert.equal(summary.total_failed_calls, 1);
  assert.equal(summary.total_tool_duration_ms, 10000);
  assert.equal(summary.by_tool.find((tool) => tool.tool_name === 'bash')?.duration_ms, 5000);
  assert.deepEqual(
    summary.by_role_runtime.map((item) => `${item.role}(${item.agent_kind})=${item.calls}`),
    ['leader(claude)=1', 'reviewer(codex)=1', 'reviewer(pi)=1'],
  );
});

test('stats includes session refs even when hook tool calls are absent', () => {
  const summary = buildStats([
    {
      type: 'session_ref',
      run_id: 'run_2',
      team_id: 'team_2',
      agent_run_id: 'agent_2',
      agent_kind: 'opencode',
      agent_name: 'worker-2',
      session_id: 'ses_2',
      session_path: '/tmp/opencode-session.jsonl',
      timestamp: '2026-07-02T00:00:00.000Z',
    },
  ]);
  assert.equal(summary.run_id, 'run_2');
  assert.deepEqual(summary.session_paths, ['/tmp/opencode-session.jsonl']);
  assert.equal(summary.total_tool_calls, 0);
});

test('finds the latest Pi session for a worktree path', () => {
  const root = mkdtempSync(join(tmpdir(), 'herdr-pi-sessions-'));
  const worktreePath = '/home/developer/.herdr/worktrees/sample-app/worktree-example-20260703074725';
  const sessionDir = join(root, '--home-developer-.herdr-worktrees-sample-app-worktree-example-20260703074725--');
  mkdirSync(sessionDir, { recursive: true });
  const oldPath = join(sessionDir, '2026-07-02T23-47-27-134Z_old.jsonl');
  const newPath = join(sessionDir, '2026-07-02T23-48-27-134Z_new.jsonl');
  writeFileSync(oldPath, '{}\n');
  writeFileSync(newPath, '{}\n');
  assert.equal(findLatestPiSessionForWorktree(worktreePath, root), newPath);
});

test('team worker trace identity can force a fresh agent run id', () => {
  const previousTeam = process.env.HERDR_TRACE_TEAM_ID;
  const previousAgent = process.env.HERDR_TRACE_AGENT_RUN_ID;
  process.env.HERDR_TRACE_TEAM_ID = 'team_from_env';
  process.env.HERDR_TRACE_AGENT_RUN_ID = 'leader_agent';
  try {
    const identity = createTraceIdentity({
      agentKind: 'codex',
      agentName: 'worker',
      agentRole: 'worker',
      parentAgentRunId: 'leader_agent',
      workerRole: 'reviewer',
      teamId: 'team_1',
      forceNewAgentRunId: true,
    });
    assert.equal(identity.team_id, 'team_1');
    assert.equal(identity.parent_agent_run_id, 'leader_agent');
    assert.equal(identity.worker_role, 'reviewer');
    assert.notEqual(identity.agent_run_id, 'leader_agent');
  } finally {
    if (previousTeam === undefined) delete process.env.HERDR_TRACE_TEAM_ID;
    else process.env.HERDR_TRACE_TEAM_ID = previousTeam;
    if (previousAgent === undefined) delete process.env.HERDR_TRACE_AGENT_RUN_ID;
    else process.env.HERDR_TRACE_AGENT_RUN_ID = previousAgent;
  }
});
