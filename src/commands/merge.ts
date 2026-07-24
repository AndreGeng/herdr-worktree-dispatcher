import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

import type { Command } from 'commander';

import { markBatchTaskMerged } from '../batch/manager.js';
import { currentRef, ensureCleanWorktree, isAncestor, revParse } from '../git/git.js';
import { readMergeToken, tokenLogPath } from '../token/token.js';
import { dispatchScriptPath } from '../utils/paths.js';
import { run } from '../utils/process.js';
import { timestamp } from '../utils/text.js';

interface MergeOptions {
  token?: string;
}

export function registerMerge(program: Command): void {
  program
    .command('merge')
    .description('Finalize a dispatcher-created implementation worktree')
    .requiredOption('--token <path>', 'Lifecycle token path')
    .action((options: MergeOptions) => runMerge(options));
}

export function runMerge(options: MergeOptions): void {
  const tokenPath = options.token || '';
  const token = readMergeToken(tokenPath);
  const logFile = tokenLogPath(tokenPath);
  log(logFile, `merge invoked token=${tokenPath} cwd=${process.cwd()} mode=${token.mode} source=${token.source_cwd} worktree=${token.worktree_path} branch=${token.branch} source_branch=${token.source_branch} merge_mode=${token.merge_mode}`);
  ensureCleanWorktree(token.worktree_path, 'status child worktree');
  ensureCleanWorktree(token.source_cwd, 'status source checkout');

  const currentSourceRef = currentRef(token.source_cwd);
  let restoreSourceRef = false;
  if (currentSourceRef !== token.source_branch) {
    log(logFile, `switching source checkout from ${currentSourceRef} to recorded source branch ${token.source_branch}`);
    run('git', ['checkout', token.source_branch], { cwd: token.source_cwd });
    restoreSourceRef = true;
  }

  try {
    const sourceHead = revParse(token.source_cwd, 'HEAD');
    if (!isAncestor(token.worktree_path, sourceHead, 'HEAD')) {
      if (token.merge_mode === 'rebase') {
        log(logFile, `running: git -C ${token.worktree_path} rebase ${sourceHead}`);
        run('git', ['rebase', sourceHead], { cwd: token.worktree_path });
      } else {
        log(logFile, `running: git -C ${token.worktree_path} merge --no-edit ${sourceHead}`);
        run('git', ['merge', '--no-edit', sourceHead], { cwd: token.worktree_path });
      }
    }
    const worktreeHead = revParse(token.worktree_path, 'HEAD');
    if (sourceHead === worktreeHead) {
      log(logFile, 'source checkout already at worktree HEAD');
    } else {
      log(logFile, `running: git -C ${token.source_cwd} merge --ff-only ${token.branch}`);
      run('git', ['merge', '--ff-only', token.branch], { cwd: token.source_cwd });
    }
  } finally {
    if (restoreSourceRef) {
      log(logFile, `restoring source checkout to ${currentSourceRef}`);
      run('git', ['checkout', currentSourceRef], { cwd: token.source_cwd });
    }
  }
  log(logFile, 'merge integration complete');
  if (token.batch_dir && token.batch_task_id) {
    markBatchTaskMerged(token.batch_dir, token.batch_task_id);
    log(logFile, `batch task marked merged batch=${token.batch_dir} task=${token.batch_task_id}`);
  }
  const child = spawn(dispatchScriptPath(import.meta.url), ['cleanup-worker', '--token', tokenPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  log(logFile, 'cleanup scheduled');
  process.stdout.write('merge complete; cleanup scheduled\n');
}

function log(logFile: string, message: string): void {
  appendFileSync(logFile, `[${timestamp()}] ${message}\n`);
}
