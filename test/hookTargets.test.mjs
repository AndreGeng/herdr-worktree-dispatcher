import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mergeCodexHooks } from '../dist/install/hookTargets.js';

test('merges Codex trace hooks without replacing existing hooks', () => {
  const existing = {
    PreToolUse: [{ command: 'cmux pre' }],
    PostToolUse: [{ command: 'cmux post' }],
    Custom: [{ command: 'keep me' }],
  };
  const merged = mergeCodexHooks(existing, 'herdr-worktree-dispatcher');

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.value.Custom, [{ command: 'keep me' }]);
  assert.deepEqual(merged.value.PreToolUse, [
    { command: 'cmux pre' },
    { command: 'herdr-worktree-dispatcher trace-hook --event PreToolUse --agent codex' },
  ]);
  assert.deepEqual(merged.value.SessionStart, [
    { command: 'herdr-worktree-dispatcher trace-hook --event SessionStart --agent codex' },
  ]);
});

test('does not duplicate Codex trace hooks on repeated merge', () => {
  const first = mergeCodexHooks({}, 'herdr-worktree-dispatcher');
  const second = mergeCodexHooks(first.value, 'herdr-worktree-dispatcher');

  assert.equal(second.changed, false);
  assert.equal(Array.isArray(second.value.PreToolUse), true);
  assert.equal((second.value.PreToolUse).length, 1);
});
