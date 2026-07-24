import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveSkillRoots } from '../dist/install/skillTargets.js';

test('resolves all built-in skill targets', () => {
  const roots = resolveSkillRoots({ agents: ['all'], customSkillDirs: [] });
  assert.deepEqual(
    roots.map((target) => [target.agent, target.root]),
    [
      ['opencode', join(homedir(), '.config/opencode/skills')],
      ['claude', join(homedir(), '.claude/skills')],
      ['codex', join(homedir(), '.codex/skills')],
      ['pi', join(homedir(), '.pi/agent/skills')],
    ],
  );
});

test('auto-detects only existing agent homes', () => {
  const existing = new Set([join(homedir(), '.claude'), join(homedir(), '.pi/agent')]);
  const roots = resolveSkillRoots({ agents: [], customSkillDirs: [], exists: (path) => existing.has(path) });
  assert.deepEqual(
    roots.map((target) => target.agent),
    ['claude', 'pi'],
  );
});

test('supports custom skill directories without duplicating targets', () => {
  const custom = join(homedir(), '.custom/skills');
  const roots = resolveSkillRoots({ agents: ['opencode'], customSkillDirs: [custom, custom] });
  assert.deepEqual(
    roots.map((target) => [target.agent, target.root]),
    [
      ['custom', custom],
      ['opencode', join(homedir(), '.config/opencode/skills')],
    ],
  );
});
