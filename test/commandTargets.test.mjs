import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installCommands, mergeOpenCodeCommands } from '../dist/install/commandTargets.js';

test('merges OpenCode dispatch commands without removing existing commands', () => {
  const merged = mergeOpenCodeCommands({ command: { w: { description: 'existing', template: 'keep me' } } });
  assert.equal(merged.value.command.w.template, 'keep me');
  assert.match(merged.value.command.dispatch.template, /add --merge/);
  assert.match(merged.value.command['dispatch-team'].template, /add --team engineering --merge/);
});

test('keeps existing OpenCode dispatch command unless forced', () => {
  const kept = mergeOpenCodeCommands({ command: { dispatch: { description: 'custom', template: 'custom' } } });
  assert.equal(kept.value.command.dispatch.template, 'custom');
  const forced = mergeOpenCodeCommands({ command: { dispatch: { description: 'custom', template: 'custom' } } }, true);
  assert.notEqual(forced.value.command.dispatch.template, 'custom');
});

test('installs OpenCode JSON and Claude command files', () => {
  const home = mkdtempSync(join(tmpdir(), 'command-targets-'));
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.config', 'opencode', 'opencode.json'), JSON.stringify({ command: { w: { description: 'w', template: 'w' } } }));

  const results = installCommands({ agents: ['opencode', 'claude'], customCommandDirs: [], packageRoot: process.cwd(), home });
  assert.equal(results.find((result) => result.agent === 'opencode')?.status, 'merged');
  const opencode = JSON.parse(readFileSync(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(opencode.command.w.template, 'w');
  assert.match(opencode.command['dispatch-team'].template, /team_token/);
  assert.equal(existsSync(join(home, '.claude', 'commands', 'dispatch.md')), true);
  assert.match(readFileSync(join(home, '.claude', 'commands', 'dispatch-team.md'), 'utf8'), /add --team engineering --merge/);
});

test('installs Codex and Pi skill aliases for command compatibility', () => {
  const home = mkdtempSync(join(tmpdir(), 'command-targets-'));
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
  const results = installCommands({ agents: ['codex', 'pi'], customCommandDirs: [], packageRoot: process.cwd(), home });
  assert.equal(existsSync(join(home, '.codex', 'skills', 'dispatch', 'SKILL.md')), true);
  assert.equal(existsSync(join(home, '.pi', 'agent', 'skills', 'dispatch-team', 'SKILL.md')), true);
  assert.equal(results.some((result) => result.agent === 'codex' && result.status === 'skipped' && /unknown/.test(result.reason || '')), true);
  assert.equal(results.some((result) => result.agent === 'pi' && result.status === 'skipped' && /unknown/.test(result.reason || '')), true);
});
