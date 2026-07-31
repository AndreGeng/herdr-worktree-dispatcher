import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { die } from '../utils/errors.js';
import { shellQuote } from '../utils/process.js';

export function teamEnvironmentPath(id: string): string {
  return join(process.env.TMPDIR || '/tmp', 'herdr-worktree-dispatcher-teams', `${id}.env`);
}

export function resolveForwardedEnvironment(
  names: string[],
  environment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) die(`invalid forwarded environment variable name: ${name}`);
    const value = environment[name];
    if (value === undefined) die(`forwarded environment variable is not set: ${name}`);
    values[name] = value;
  }
  return values;
}

export function writeTeamEnvironmentFile(path: string, values: Record<string, string>): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const contents = Object.entries(values).map(([name, value]) => `${name}=${shellQuote(value)}`).join('\n');
    writeFileSync(path, `${contents}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

export function formatTeamEnvironmentPrefix(path: string | undefined): string {
  return path ? `set -a; . ${shellQuote(path)} || exit $?; rm -f ${shellQuote(path)} || exit $?; set +a; ` : '';
}

export function removeTeamEnvironmentFile(path: string | undefined): void {
  if (path) rmSync(path, { force: true });
}
