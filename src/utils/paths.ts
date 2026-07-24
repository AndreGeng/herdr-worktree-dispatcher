import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export function repoRootFromMeta(importMetaUrl: string): string {
  const file = fileURLToPath(importMetaUrl);
  return dirname(dirname(dirname(file)));
}

export function dispatchScriptPath(importMetaUrl: string): string {
  return process.env.HERDR_WORKTREE_DISPATCHER_SCRIPT || join(repoRootFromMeta(importMetaUrl), 'scripts', 'dispatch.sh');
}
