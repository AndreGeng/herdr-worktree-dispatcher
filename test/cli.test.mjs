import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('help uses the package binary name', () => {
  const output = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });

  assert.match(output, /Usage: herdr-worktree-dispatcher/);
  assert.doesNotMatch(output, /Usage: dispatch\.sh/);
});

test('team command is registered', () => {
  const output = execFileSync(process.execPath, ['dist/cli.js', 'team', '--help'], { encoding: 'utf8' });

  assert.match(output, /spawn/);
  assert.match(output, /status/);
  assert.match(output, /events/);
  assert.match(output, /plan/);
  assert.match(output, /update/);
  assert.match(output, /finish/);
  assert.match(output, /message/);
  assert.doesNotMatch(output, /^\s{2}done\s+\[/m);
  assert.doesNotMatch(output, /^\s{2}progress\s+\[/m);
  assert.doesNotMatch(output, /^\s{2}handoff\s+\[/m);
  assert.doesNotMatch(output, /^\s{2}preflight\s+\[/m);
});

test('connector, source, and batch commands are registered', () => {
  const connector = execFileSync(process.execPath, ['dist/cli.js', 'connector', '--help'], { encoding: 'utf8' });
  const source = execFileSync(process.execPath, ['dist/cli.js', 'source', '--help'], { encoding: 'utf8' });
  const batch = execFileSync(process.execPath, ['dist/cli.js', 'batch', '--help'], { encoding: 'utf8' });

  assert.match(connector, /list/);
  assert.match(connector, /describe/);
  assert.match(connector, /check/);
  assert.match(source, /inspect/);
  assert.match(source, /prepare/);
  assert.match(source, /refresh/);
  assert.match(batch, /review/);
  assert.match(batch, /verify/);
  assert.match(batch, /preview/);
  assert.match(batch, /dispatch/);
});

test('init command is registered with plugin-only option', () => {
  const output = execFileSync(process.execPath, ['dist/cli.js', 'init', '--help'], { encoding: 'utf8' });

  assert.match(output, /--plugin-only/);
  assert.match(output, /--skip-build/);
  assert.match(output, /--skip-commands/);
  assert.match(output, /--force-command/);
});
