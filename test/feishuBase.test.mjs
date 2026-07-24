import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FeishuBaseConnector,
  inferMapping,
  parseBaseUrl,
  parseJsonOutput,
} from '../dist/connectors/feishuBase.js';

const fields = [
  { field_id: 'fld-title', field_name: '问题标题', type: 1, is_primary: true },
  { field_id: 'fld-description', field_name: '问题描述', type: 1 },
  { field_id: 'fld-status', field_name: '处理状态', type: 3 },
  { field_id: 'fld-priority', field_name: '优先级', type: 3 },
  { field_id: 'fld-owner', field_name: '负责人', type: 11 },
  { field_id: 'fld-assets', field_name: '问题截图', type: 17 },
];

test('parses Feishu Base URL and rejects unscoped inputs', () => {
  assert.deepEqual(
    parseBaseUrl('https://tenant.feishu.cn/base/app123?table=tbl123&view=vew123'),
    {
      url: 'https://tenant.feishu.cn/base/app123?table=tbl123&view=vew123',
      appToken: 'app123',
      tableId: 'tbl123',
      viewId: 'vew123',
    },
  );
  assert.throws(() => parseBaseUrl('https://example.com/base/app?table=tbl'), /Feishu/);
  assert.throws(() => parseBaseUrl('https://tenant.feishu.cn/base/app'), /table/);
});

test('extracts JSON from noisy Feishu output', () => {
  assert.deepEqual(parseJsonOutput('notice\n{"data":{"items":[]}}\nupdate available'), {
    data: { items: [] },
  });
});

test('infers semantic fields and reports low-confidence required roles', () => {
  const mapping = inferMapping(fields, [], ['description', 'priority']);
  assert.equal(mapping.resolved.description, '问题描述');
  assert.equal(mapping.resolved.priority, '优先级');
  assert.equal(mapping.needsConfirmation, false);

  const ambiguous = inferMapping([{ field_id: 'x', field_name: '其他', type: 1 }], [], ['description']);
  assert.equal(ambiguous.needsConfirmation, true);
  assert.deepEqual(ambiguous.ambiguousRoles, ['description']);
});

test('inspect never downloads attachments and prepare requires explicit criteria from its caller', async () => {
  const root = mkdtempSync(join(tmpdir(), 'feishu-connector-'));
  const sourceAsset = join(root, 'source.png');
  writeFileSync(sourceAsset, Buffer.from('not-a-real-png'));
  const records = [
    {
      record_id: 'rec-p1',
      fields: {
        问题标题: 'P1 issue',
        问题描述: 'Fix the P1 issue',
        处理状态: '待处理',
        优先级: 'P1',
        负责人: [{ name: 'User One' }],
        问题截图: [{
          file_token: 'token-1',
          name: 'screen.png',
          size: 14,
          mime_type: 'image/png',
          source_path: sourceAsset,
        }],
      },
    },
    {
      record_id: 'rec-done',
      fields: {
        问题标题: 'Resolved',
        问题描述: 'Already resolved',
        处理状态: '已解决',
        优先级: 'P0',
        负责人: [{ name: 'User Two' }],
      },
    },
  ];
  let fetchCalls = 0;
  const runner = {
    exists: () => true,
    run(_command, args) {
      if (args[0] === '--version') return '1.3.0';
      if (args[0] === 'bitable' && args[1] === 'fields') return JSON.stringify({ data: { items: fields } });
      if (args[0] === 'bitable' && args[1] === 'records') return JSON.stringify({ data: { items: records, has_more: false } });
      if (args[0] === 'fetch') {
        fetchCalls += 1;
        throw new Error('fixture source_path should avoid fetch');
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  };
  const connector = new FeishuBaseConnector(runner);
  const batchDir = join(root, 'batch');
  mkdirSync(batchDir);
  const inspection = await connector.inspect({
    source: 'https://tenant.feishu.cn/base/app?table=tbl&view=vew',
  }, { sourceCwd: root, batchDir });
  assert.equal(fetchCalls, 0);
  assert.equal(inspection.recordCount, 2);
  assert.equal(inspection.selectionRequired, true);
  assert.equal(inspection.attachmentCount, 1);

  const prepared = await connector.prepare({
    inspection,
    criteria: {
      where: { all: [{ role: 'status', op: 'not_equals', value: '已解决' }] },
      sort: [{ role: 'priority', direction: 'semantic' }],
    },
    selectionMode: 'criteria',
    allowLargeAttachments: false,
  }, { sourceCwd: root, batchDir });
  assert.equal(prepared.selectedRecordCount, 1);
  assert.equal(prepared.skippedRecordCount, 1);
  assert.equal(prepared.tasks[0].sourceRecordId, 'rec-p1');
  assert.equal(prepared.assets.length, 1);
  assert.equal(readFileSync(join(batchDir, prepared.assets[0].relativePath), 'utf8'), 'not-a-real-png');
});
