import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { die } from '../utils/errors.js';
import { slugify } from '../utils/text.js';
import { addDispatcherDirToExclude } from '../prompt/addPrompt.js';

export const BATCH_INTERNAL_DIR = '.internal';

export function utcNow(): string {
  return new Date().toISOString();
}

export function sha256Buffer(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function digestJson(value: unknown): string {
  return sha256Buffer(stableJson(value));
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readJson<T>(path: string, label = basename(path)): T {
  if (!existsSync(path)) die(`${label} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    die(`${label} is not valid JSON: ${path}`);
  }
}

export function batchRoot(sourceCwd: string): string {
  return join(sourceCwd, '.herdr-worktree-dispatcher', 'batches');
}

export function createBatchDir(sourceCwd: string, source: string, explicit?: string): string {
  addDispatcherDirToExclude(sourceCwd);
  if (explicit) {
    const output = resolve(explicit);
    const root = resolve(batchRoot(sourceCwd));
    const rel = relative(root, output);
    if (!rel || rel.startsWith('..')) die(`batch output must be a specific directory under ${root}`);
    mkdirSync(output, { recursive: true, mode: 0o700 });
    return output;
  }
  const stamp = utcNow().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const parsed = source.split(/[/?#]/).filter(Boolean).slice(-2).join('-');
  const name = `${stamp}-${slugify(parsed || 'source')}`;
  const output = join(batchRoot(sourceCwd), name);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  return output;
}

export function internalPath(batchDir: string, name: string): string {
  return join(batchDir, BATCH_INTERNAL_DIR, name);
}

export function assertBatchDir(batchDir: string): string {
  const resolved = resolve(batchDir);
  if (!existsSync(resolved)) die(`batch directory not found: ${resolved}`);
  if (!existsSync(internalPath(resolved, 'inspection.json'))) die(`not a dispatcher batch: ${resolved}`);
  return resolved;
}

export function cleanBatch(batchDir: string, sourceCwd: string): void {
  const root = resolve(batchRoot(sourceCwd));
  const target = realpathSync(assertBatchDir(batchDir));
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    die(`refusing to clean path outside a specific batch under ${root}`);
  }
  rmSync(target, { recursive: true });
}
