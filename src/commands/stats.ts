import { existsSync, readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { formatStats } from '../trace/format.js';
import { findLatestPiSessionForWorktree } from '../trace/piSessions.js';
import { latestTraceIndexPath } from '../trace/paths.js';
import { parseSessionFallback, readTraceRecords } from '../trace/parsers.js';
import { buildStats } from '../trace/stats.js';
import type { LatestTraceIndex, TraceIdentity, TraceRecord } from '../trace/types.js';
import { readMergeToken } from '../token/token.js';
import { die } from '../utils/errors.js';

interface StatsOptions {
  token?: string;
  latest?: boolean;
}

export function registerStats(program: Command): void {
  program
    .command('stats')
    .description('Show worker tool-duration stats')
    .option('--token <path>', 'Read trace metadata from a merge token')
    .option('--latest', 'Show the latest dispatched run')
    .action((options: StatsOptions) => runStats(options));
}

export function runStats(options: StatsOptions): void {
  if (options.token && options.latest) die('use either --token or --latest, not both');
  const index = options.token ? indexFromToken(options.token) : indexFromLatest(options.latest);
  const records = loadRecords(index);
  process.stdout.write(formatStats(buildStats(records)));
}

function indexFromToken(tokenPath: string): LatestTraceIndex {
  const token = readMergeToken(tokenPath);
  return {
    ...identityFromToken(token, tokenPath),
    token_path: tokenPath,
    session_path: token.agent_session_path,
    worktree_path: token.worktree_path,
    branch: token.branch,
    source_cwd: token.source_cwd,
  };
}

function indexFromLatest(latest?: boolean): LatestTraceIndex {
  if (!latest) die('stats requires --token <path> or --latest');
  const path = latestTraceIndexPath();
  if (!existsSync(path)) die(`latest trace index not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LatestTraceIndex;
  } catch {
    die(`latest trace index is not valid JSON: ${path}`);
  }
}

function loadRecords(index: LatestTraceIndex): TraceRecord[] {
  const records = readTraceRecords(index.trace_file);
  const sessionPaths = new Set<string>();
  if (index.session_path) sessionPaths.add(index.session_path);
  const inferredSessionPath = inferSessionPath(index);
  if (inferredSessionPath) sessionPaths.add(inferredSessionPath);
  for (const record of records) {
    if (record.type === 'session_ref' && record.session_path) sessionPaths.add(record.session_path);
  }
  for (const sessionPath of sessionPaths) {
    records.push(...parseSessionFallback(sessionPath, index));
  }
  if (records.length === 0 && sessionPaths.size === 0) {
    records.push({
      type: 'agent_start',
      run_id: index.run_id,
      team_id: index.team_id,
      agent_run_id: index.agent_run_id,
      parent_agent_run_id: index.parent_agent_run_id,
      agent_role: index.agent_role,
      agent_kind: index.agent_kind,
      agent_name: index.agent_name,
      timestamp: index.dispatch_started_at,
    });
  }
  return records;
}

function inferSessionPath(index: LatestTraceIndex): string | undefined {
  if (index.agent_kind !== 'pi') return undefined;
  return findLatestPiSessionForWorktree(index.worktree_path, index.session_search_root);
}

function identityFromToken(token: ReturnType<typeof readMergeToken>, tokenPath: string): TraceIdentity {
  const dispatchStartedAt = token.dispatch_started_at || new Date().toISOString();
  const runId = token.run_id || `run_${sanitize(token.branch)}`;
  const agentRunId = token.agent_run_id || `agent_${sanitize(token.agent_name || token.branch)}`;
  return {
    run_id: runId,
    team_id: token.team_id,
    agent_run_id: agentRunId,
    parent_agent_run_id: token.parent_agent_run_id,
    agent_role: token.agent_role || 'solo',
    agent_kind: token.agent_kind || 'unknown',
    agent_name: token.agent_name || agentRunId,
    trace_file: token.trace_file || tokenPath.replace(/\.json$/, '.trace.jsonl'),
    dispatch_started_at: dispatchStartedAt,
  };
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}
