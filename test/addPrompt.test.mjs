import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAddPrompt } from '../dist/prompt/addPrompt.js';

test('plain dispatch prompt applies configured language to summaries and generated files', () => {
  const prompt = buildAddPrompt({
    taskText: 'Review the implementation',
    language: 'en-US',
    mergeInstruction: false,
    mergeMode: 'rebase',
    sourceCwd: '/tmp/source',
  });

  assert.match(prompt, /Language: use en-US for natural-language summaries and generated human-readable file content/);
  assert.match(prompt, /Keep code identifiers, commands, paths, and original error text unchanged/);
});
