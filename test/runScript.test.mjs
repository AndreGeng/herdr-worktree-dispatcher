import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writeWorktreeRunScript } from '../dist/prompt/addPrompt.js';

test('worktree run scripts hide long pane commands behind a short executable path', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'run-script-'));
  const gitDir = join(worktree, '.git');
  mkdirSync(gitDir);
  mkdirSync(join(gitDir, 'info'));
  writeFileSync(join(gitDir, 'info', 'exclude'), '');

  const script = writeWorktreeRunScript(worktree, 'worker task', "set +e; echo 'hello'; status=$?; exit \"$status\"");

  assert.equal(script, join(worktree, '.herdr-worktree-dispatcher', 'runs', 'worker-task.sh'));
  assert.equal(readFileSync(script, 'utf8'), "#!/bin/sh\nset +e; echo 'hello'; status=$?; exit \"$status\"\n");
  assert.equal((statSync(script).mode & 0o777), 0o700);
  assert.match(readFileSync(join(gitDir, 'info', 'exclude'), 'utf8'), /\.herdr-worktree-dispatcher\//);
});
