import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { die } from '../utils/errors.js';
import { run } from '../utils/process.js';

export function repoRoot(cwd: string): string {
  try {
    return run('git', ['rev-parse', '--show-toplevel'], { cwd }).trim();
  } catch {
    die(`current workspace is not inside a git repository: ${cwd}`);
  }
}

export function resolveCommit(cwd: string, ref: string): string {
  try {
    return run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd }).trim();
  } catch {
    die(`base ref is not a commit: ${ref}. If this is a new repository, create an initial commit before dispatching a worktree.`);
  }
}

export function currentBranchOrCommit(cwd: string, fallbackCommit: string): string {
  const branch = runMaybe('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).trim();
  return branch || fallbackCommit;
}

export function currentRef(cwd: string): string {
  return runMaybe('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd).trim() || run('git', ['rev-parse', '--verify', 'HEAD'], { cwd }).trim();
}

export function revParse(cwd: string, ref: string): string {
  return run('git', ['rev-parse', '--verify', ref], { cwd }).trim();
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    run('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch {
    return false;
  }
}

export function ensureCleanWorktree(path: string, label: string): void {
  const status = run('git', ['status', '--porcelain', '--', ':!/.herdr-worktree-dispatcher'], { cwd: path });
  if (status.trim()) die(`${label}: worktree has uncommitted changes; commit or clean them before merge`);
}

export function isWorktreeDirty(path: string): boolean {
  return Boolean(run('git', ['status', '--porcelain', '--', ':!/.herdr-worktree-dispatcher'], { cwd: path }).trim());
}

export function worktreeIsRegistered(root: string, worktreePath: string): boolean {
  const output = run('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  return output.split(/\r?\n/).some((line) => line === `worktree ${worktreePath}`);
}

export function gitDirForWorktree(worktreePath: string): string | undefined {
  const gitFile = join(worktreePath, '.git');
  if (!existsSync(gitFile)) return undefined;
  try {
    const stat = readFileSync(gitFile, 'utf8');
    const match = stat.match(/^gitdir: (.+)$/m);
    if (!match) return join(gitFile, 'info');
    const gitDir = match[1].startsWith('/') ? match[1] : join(worktreePath, match[1]);
    return dirname(dirname(gitDir));
  } catch {
    return gitFile;
  }
}

function runMaybe(command: string, args: string[], cwd: string): string {
  try {
    return run(command, args, { cwd });
  } catch {
    return '';
  }
}
