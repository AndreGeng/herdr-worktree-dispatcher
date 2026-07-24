import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { die } from './errors.js';

export function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-lc', `command -v ${shellQuote(firstCommandToken(command))} >/dev/null 2>&1`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

export function requireCommand(command: string): void {
  if (!commandExists(command)) {
    die(`missing required command: ${command}`);
  }
}

export function run(command: string, args: string[], options: { cwd?: string; input?: string } = {}): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      input: options.input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
      if (stderr) {
        die(stderr);
      }
    }
    die(`command failed: ${command} ${args.join(' ')}`);
  }
}

export function runInherit(command: string, args: string[], options: { cwd?: string } = {}): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    die(`command failed: ${command} ${args.join(' ')}`);
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/)[0] || command;
}

export function assertFile(path: string, label: string): void {
  if (!existsSync(path)) {
    die(`${label} not found: ${path}`);
  }
}
