import { appendFileSync, existsSync, rmSync } from 'node:fs';

import type { Command } from 'commander';

import { worktreeIsRegistered } from '../git/git.js';
import { removeWorktree } from '../herdr/client.js';
import { readMergeToken, tokenLogPath } from '../token/token.js';
import { run } from '../utils/process.js';
import { timestamp } from '../utils/text.js';

interface CleanupOptions {
  token?: string;
}

export function registerCleanupWorker(program: Command): void {
  program
    .command('cleanup-worker')
    .description('Internal command. Runs detached cleanup after merge integration')
    .requiredOption('--token <path>', 'Lifecycle token path')
    .action((options: CleanupOptions) => runCleanupWorker(options));
}

export function runCleanupWorker(options: CleanupOptions): void {
  const tokenPath = options.token || '';
  const token = readMergeToken(tokenPath);
  const logFile = tokenLogPath(tokenPath);
  log(logFile, `cleanup worker invoked token=${tokenPath} cwd=${process.cwd()}`);
  log(logFile, `token workspace=${token.worktree_workspace_id} repo_root=${token.repo_root} worktree_path=${token.worktree_path} branch=${token.branch} tab=${token.tab_id}`);
  try {
    log(logFile, `running: ${token.herdr_bin} worktree remove --workspace ${token.worktree_workspace_id}`);
    removeWorktree(token.herdr_bin, token.worktree_workspace_id);
    log(logFile, 'herdr worktree remove succeeded');
  } catch (error) {
    log(logFile, `herdr worktree remove failed: ${(error as Error).message}`);
    throw error;
  }
  if (worktreeIsRegistered(token.repo_root, token.worktree_path)) {
    try {
      log(logFile, `running: git -C ${token.repo_root} worktree remove ${token.worktree_path}`);
      run('git', ['worktree', 'remove', token.worktree_path], { cwd: token.repo_root });
      log(logFile, 'git worktree remove succeeded');
    } catch (error) {
      log(logFile, `git worktree remove failed: ${(error as Error).message}`);
    }
  }
  try {
    const sourceBranch = token.source_branch;
    const canForceDelete = sourceBranch
      ? runMaybe('git', ['merge-base', '--is-ancestor', token.branch, sourceBranch], token.repo_root)
      : false;
    run('git', ['branch', canForceDelete ? '-D' : '-d', token.branch], { cwd: token.repo_root });
    log(logFile, `temporary branch delete succeeded: ${token.branch}`);
  } catch (error) {
    log(logFile, `temporary branch delete failed: ${(error as Error).message}`);
    throw error;
  }
  if (token.prompt_file && existsSync(token.prompt_file)) {
    try {
      rmSync(token.prompt_file);
      log(logFile, `removed prompt file ${token.prompt_file}`);
    } catch (error) {
      log(logFile, `prompt cleanup failed: ${(error as Error).message}`);
    }
  }
  try {
    rmSync(tokenPath);
    log(logFile, 'cleanup complete; removed token');
  } catch (error) {
    log(logFile, `token cleanup failed: ${(error as Error).message}`);
  }
}

function log(logFile: string, message: string): void {
  appendFileSync(logFile, `[${timestamp()}] ${message}\n`);
}

function runMaybe(command: string, args: string[], cwd: string): boolean {
  try {
    run(command, args, { cwd });
    return true;
  } catch {
    return false;
  }
}
