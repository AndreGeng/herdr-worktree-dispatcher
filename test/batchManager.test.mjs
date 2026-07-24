import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  initializeInspectionBatch,
  prepareBatch,
  previewBatch,
  verifyBatch,
} from '../dist/batch/manager.js';
import { digestJson, internalPath, readJson, sha256File, writeJson } from '../dist/batch/storage.js';

function inspection() {
  return {
    connector: 'fixture',
    connectorVersion: '1',
    source: { connector: 'fixture', url: 'fixture://tasks', metadata: {} },
    inspectedAt: new Date().toISOString(),
    snapshot: 'snapshot',
    recordCount: 1,
    fields: [],
    facets: [],
    mapping: {
      resolved: { title: 'Title', description: 'Description', attachments: ['Files'] },
      candidates: {},
      requiredRoles: ['description'],
      ambiguousRoles: [],
      needsConfirmation: false,
    },
    attachmentCount: 0,
    attachmentBytes: 0,
    warnings: [],
    selectionRequired: true,
    connectorState: {},
  };
}

test('inspection produces a Markdown review and no task bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-inspect-'));
  const batch = join(root, '.herdr-worktree-dispatcher', 'batches', 'one');
  mkdirSync(batch, { recursive: true });
  initializeInspectionBatch(batch, inspection());
  assert.equal(existsSync(join(batch, 'REVIEW.md')), true);
  assert.equal(existsSync(internalPath(batch, 'bundle.json')), false);
  assert.match(readFileSync(join(batch, 'REVIEW.md'), 'utf8'), /confirmation required/);
});

test('prepared tasks are human-readable and image placeholders block verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'batch-prepare-'));
  writeFileSync(join(root, 'AGENTS.md'), 'Only run focused tests.');
  const batch = join(root, '.herdr-worktree-dispatcher', 'batches', 'one');
  const assetDir = join(batch, 'assets', 'rec-1');
  mkdirSync(assetDir, { recursive: true });
  const assetPath = join(assetDir, 'screen.png');
  writeFileSync(assetPath, 'image');
  const asset = {
    id: 'rec-1:1',
    sourceRecordId: 'rec-1',
    originalName: 'screen.png',
    relativePath: 'assets/rec-1/screen.png',
    mime: 'image/png',
    size: 5,
    sha256: sha256File(assetPath),
    required: true,
    kind: 'image',
    readingPolicy: 'inspect-image',
  };
  const inspected = inspection();
  initializeInspectionBatch(batch, inspected);
  const prepared = {
    connector: 'fixture',
    connectorVersion: '1',
    source: inspected.source,
    snapshot: inspected.snapshot,
    selection: {
      mode: 'all_visible_records',
      criteria: { where: {}, sort: [] },
      confirmedAt: new Date().toISOString(),
      digest: digestJson('confirmed'),
    },
    sourceRecordCount: 1,
    selectedRecordCount: 1,
    skippedRecordCount: 0,
    tasks: [{
      sourceRecordId: 'rec-1',
      title: 'Image bug',
      description: 'Fix the screenshot issue',
      owner: [],
      labels: [],
      originalFields: { Title: 'Image bug' },
      assets: [asset],
    }],
    assets: [asset],
    connectorState: {},
    warnings: [],
  };
  const bundle = prepareBatch(batch, prepared, inspected);
  assert.match(readFileSync(bundle.tasks[0].promptFile, 'utf8'), /ATTACHMENT_OBSERVATION_REQUIRED/);
  assert.match(readFileSync(bundle.tasks[0].promptFile, 'utf8'), /Only run focused tests/);
  assert.match(readFileSync(join(batch, 'REVIEW.md'), 'utf8'), /Image bug/);
  assert.equal(verifyBatch(batch).valid, false);

  writeFileSync(
    bundle.tasks[0].promptFile,
    readFileSync(bundle.tasks[0].promptFile, 'utf8')
      .replace('ATTACHMENT_OBSERVATION_REQUIRED:', 'Observed:'),
  );
  assert.equal(verifyBatch(batch).valid, true);
  assert.equal(Boolean(readJson(internalPath(batch, 'verification.json')).contentDigest), true);

  writeJson(internalPath(batch, 'refresh.json'), {
    state: 'unchanged',
    changes: [],
    requiresReconfirmation: false,
    snapshot: inspected.snapshot,
  });
  const codexConfig = join(root, 'codex.env');
  writeFileSync(codexConfig, '[default]\nagent = codex\n');
  const codexPreview = previewBatch(batch, root, { configFile: codexConfig });
  assert.equal(codexPreview.tasks[0].state, 'ready');
  assert.equal(Boolean(codexPreview.digest), true);

  const opencodeConfig = join(root, 'opencode.env');
  writeFileSync(opencodeConfig, '[default]\nagent = opencode\n');
  const opencodePreview = previewBatch(batch, root, { configFile: opencodeConfig });
  assert.equal(opencodePreview.tasks[0].state, 'blocked');
  assert.match(opencodePreview.tasks[0].blockedReason, /image-input/);
});
