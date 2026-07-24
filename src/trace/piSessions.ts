import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export function findLatestPiSessionForWorktree(worktreePath: string, root = defaultPiSessionRoot()): string | undefined {
  if (!worktreePath || !existsSync(root)) return undefined;
  const sessionDir = join(root, encodePiSessionDirectory(worktreePath));
  if (!existsSync(sessionDir)) return undefined;
  const candidates = readdirSync(sessionDir)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => join(sessionDir, name))
    .filter((path) => safeIsFile(path))
    .sort((a, b) => safeMtimeMs(b) - safeMtimeMs(a));
  return candidates[0];
}

export function encodePiSessionDirectory(cwd: string): string {
  return `--${cwd.replace(/^\/+/, '').replace(/\//g, '-')}--`;
}

export function defaultPiSessionRoot(): string {
  return join(homedir(), '.pi', 'agent', 'sessions');
}

function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Number(basename(path).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)?.[0] ?? 0);
  }
}
