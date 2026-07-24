import assert from 'node:assert/strict';
import test from 'node:test';

import { labelFromTask } from '../dist/utils/text.js';

test('labelFromTask ignores dispatcher orchestration words', () => {
  assert.equal(labelFromTask('sample-chat checkout worktree leader agent shared worker role merge'), 'sample-chat-checkout');
});
