import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { shellQuote } from '../utils/process.js';

export interface BackgroundWorkerInput {
  cwd: string;
  command: string;
  teamTokenPath: string;
  workerId: string;
  scriptPath: string;
}

export interface BackgroundWorkerResult {
  pid?: number;
  logFile: string;
}

export function backgroundWorkerLogFile(cwd: string, workerId: string): string {
  return join(cwd, '.herdr-worktree-dispatcher', 'workers', `${workerId}.log`);
}

export function startBackgroundWorker(input: BackgroundWorkerInput): BackgroundWorkerResult {
  const logFile = backgroundWorkerLogFile(input.cwd, input.workerId);
  mkdirSync(dirname(logFile), { recursive: true });
  writeFileSync(logFile, `# herdr worktree dispatcher worker log\nworker_id=${input.workerId}\nstarted_at=${new Date().toISOString()}\n\n`);
  const wrapper = buildBackgroundWorkerScript(input, logFile);
  const child = spawn('sh', ['-lc', wrapper], {
    cwd: input.cwd,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { pid: child.pid, logFile };
}

function buildBackgroundWorkerScript(input: BackgroundWorkerInput, logFile: string): string {
  const doneCommand = `${shellQuote(input.scriptPath)} team done --token ${shellQuote(input.teamTokenPath)} --worker ${shellQuote(input.workerId)}`;
  return [
    `exec >>${shellQuote(logFile)} 2>&1`,
    `set +e`,
    input.command,
    `status=$?`,
    `printf '\\nworker_exit_code=%s\\nfinished_at=%s\\n' "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    `${doneCommand} --exit-code "$status" >/dev/null 2>&1`,
    `exit "$status"`,
  ].join('; ');
}
