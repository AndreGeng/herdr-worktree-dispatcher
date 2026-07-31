import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { formatTeamEnvironmentPrefix, resolveForwardedEnvironment, writeTeamEnvironmentFile } from '../dist/team/environment.js';

test('team environment snapshots only explicitly allowed variables', () => {
  const values = resolveForwardedEnvironment(
    ['FIGMA_ACCESS_TOKEN', 'DESIGN_API_KEY'],
    { FIGMA_ACCESS_TOKEN: 'figma-secret', DESIGN_API_KEY: 'design-secret', UNRELATED_SECRET: 'do-not-copy' },
  );

  assert.deepEqual(values, {
    FIGMA_ACCESS_TOKEN: 'figma-secret',
    DESIGN_API_KEY: 'design-secret',
  });
});

test('team environment rejects missing allowed variables before dispatch', () => {
  assert.throws(
    () => resolveForwardedEnvironment(['FIGMA_ACCESS_TOKEN'], {}),
    /forwarded environment variable is not set: FIGMA_ACCESS_TOKEN/,
  );
});

test('team environment file is private and sourced without embedding secrets in commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-environment-'));
  const path = join(dir, 'team.env');
  writeTeamEnvironmentFile(path, { FIGMA_ACCESS_TOKEN: "secret with ' quote" });

  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, 'utf8'), /FIGMA_ACCESS_TOKEN=/);
  const prefix = formatTeamEnvironmentPrefix(path);
  assert.match(prefix, /set -a; \. '/);
  assert.doesNotMatch(prefix, /secret with/);

  const result = spawnSync('sh', ['-lc', `${prefix} test "$FIGMA_ACCESS_TOKEN" = "secret with ' quote"`]);
  assert.equal(result.status, 0);
  assert.equal(existsSync(path), false);
});

test('team environment prefix is empty when no forwarding is configured', () => {
  assert.equal(formatTeamEnvironmentPrefix(undefined), '');
});

test('team environment sourcing fails before launching when the private file is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-environment-missing-'));
  const missing = join(dir, 'missing.env');
  const marker = join(dir, 'launched');

  const result = spawnSync('sh', ['-lc', `${formatTeamEnvironmentPrefix(missing)} touch ${JSON.stringify(marker)}`]);

  assert.notEqual(result.status, 0);
  assert.equal(existsSync(marker), false);
});
