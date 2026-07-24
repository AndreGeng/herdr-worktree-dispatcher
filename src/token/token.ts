import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { die } from '../utils/errors.js';
import { slugify } from '../utils/text.js';

export interface MergeToken {
  mode: 'merge';
  herdr_bin: string;
  tab_id: string;
  worktree_workspace_id: string;
  repo_root: string;
  worktree_path: string;
  branch: string;
  source_cwd: string;
  source_branch: string;
  merge_mode: 'rebase' | 'merge';
  agent_name: string;
  prompt_file: string;
  run_id?: string;
  team_id?: string;
  agent_run_id?: string;
  parent_agent_run_id?: string;
  agent_role?: 'solo' | 'leader' | 'worker';
  agent_kind?: 'pi' | 'opencode' | 'claude' | 'codex' | 'unknown';
  trace_file?: string;
  dispatch_started_at?: string;
  agent_session_id?: string;
  agent_session_path?: string;
  batch_dir?: string;
  batch_task_id?: string;
}

export function createTokenPath(label: string): string {
  const cleanupDir = `${process.env.TMPDIR || '/tmp'}/herdr-worktree-dispatcher-cleanup`;
  mkdirSync(cleanupDir, { recursive: true });
  const stamp = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  const timestamp = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
  return `${cleanupDir}/${slugify(label)}-${timestamp}-${process.pid}.json`;
}

export function tokenLogPath(tokenPath: string): string {
  return tokenPath.replace(/\.json$/, '.log');
}

export function writeToken(path: string, token: MergeToken): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(token, null, 2)}\n`);
}

export function readMergeToken(path: string): MergeToken {
  if (!existsSync(path)) die(`merge token not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    die(`merge token is not valid JSON: ${path}`);
  }
  const token = parsed as Partial<MergeToken>;
  const required: Array<keyof MergeToken> = [
    'mode',
    'source_cwd',
    'repo_root',
    'worktree_path',
    'branch',
    'source_branch',
    'worktree_workspace_id',
  ];
  for (const key of required) {
    if (!token[key]) die(`merge token missing ${key}`);
  }
  if (token.mode !== 'merge') die(`invalid merge token mode: ${token.mode || 'empty'}`);
  if (token.merge_mode !== 'merge' && token.merge_mode !== 'rebase') token.merge_mode = 'rebase';
  if (!token.herdr_bin) token.herdr_bin = 'herdr';
  if (!token.agent_name) token.agent_name = '';
  if (!token.tab_id) token.tab_id = '';
  if (!token.prompt_file) token.prompt_file = '';
  return token as MergeToken;
}
