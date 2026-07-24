import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentStartArgs, buildPaneCloseArgs, buildPaneRunArgs, buildPaneSplitArgs } from '../dist/herdr/client.js';

test('agent start reuses the current tab pane by default', () => {
  const args = buildAgentStartArgs({
    agentName: 'wt-task',
    workspaceId: 'ws_1',
    cwd: '/repo/worktree',
    command: 'codex exec "task"',
    tabId: 'tab_1',
  });

  assert.deepEqual(args, [
    'agent', 'start', 'wt-task', '--workspace', 'ws_1', '--tab', 'tab_1', '--cwd', '/repo/worktree', '--no-focus', '--', 'sh', '-lc', 'codex exec "task"',
  ]);
  assert.equal(args.includes('--split'), false);
});

test('agent start still supports explicit split when requested', () => {
  const args = buildAgentStartArgs({
    agentName: 'wt-task',
    workspaceId: 'ws_1',
    cwd: '/repo/worktree',
    split: 'right',
    command: 'codex exec "task"',
  });

  assert.deepEqual(args, [
    'agent', 'start', 'wt-task', '--workspace', 'ws_1', '--cwd', '/repo/worktree', '--split', 'right', '--no-focus', '--', 'sh', '-lc', 'codex exec "task"',
  ]);
});

test('pane run executes an agent command in an existing pane', () => {
  assert.deepEqual(buildPaneRunArgs('pane_1', 'codex exec "task"'), ['pane', 'run', 'pane_1', 'codex exec "task"']);
});

test('pane split creates an unfocused worker pane in the shared worktree', () => {
  assert.deepEqual(buildPaneSplitArgs({ paneId: 'leader_pane', direction: 'right', cwd: '/repo/worktree', focus: false }), [
    'pane', 'split', 'leader_pane', '--direction', 'right', '--cwd', '/repo/worktree', '--no-focus',
  ]);
});

test('pane close closes a worker pane by id', () => {
  assert.deepEqual(buildPaneCloseArgs('worker_pane'), ['pane', 'close', 'worker_pane']);
});
