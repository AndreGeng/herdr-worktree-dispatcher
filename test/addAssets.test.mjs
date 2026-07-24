import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { materializeTaskAssets } from '../dist/commands/add.js';

test('materializes task assets inside the child worktree with collision-safe names', () => {
  const root = mkdtempSync(join(tmpdir(), 'add-assets-'));
  const sourceA = join(root, 'a.txt');
  const sourceB = join(root, 'b.txt');
  const worktree = join(root, 'worktree');
  writeFileSync(sourceA, 'alpha');
  writeFileSync(sourceB, 'beta');

  const assets = materializeTaskAssets(worktree, [
    { sourcePath: sourceA, name: 'log.txt' },
    { sourcePath: sourceB, name: 'log.txt', image: true },
  ]);

  assert.equal(assets.length, 2);
  assert.equal(readFileSync(assets[0].path, 'utf8'), 'alpha');
  assert.equal(readFileSync(assets[1].path, 'utf8'), 'beta');
  assert.equal(assets[1].path.endsWith('log-2.txt'), true);
  assert.equal(assets[1].image, true);
  assert.equal(existsSync(join(worktree, '.herdr-worktree-dispatcher', 'assets')), true);
});
