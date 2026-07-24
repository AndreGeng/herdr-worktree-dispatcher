import assert from 'node:assert/strict';
import test from 'node:test';

import { ConnectorRegistry } from '../dist/connectors/registry.js';

function connector(type, predicate = () => false) {
  return {
    type,
    version: '1',
    canHandle: predicate,
    async check() { return { ready: true, problems: [] }; },
    async inspect() { throw new Error('unused'); },
    async prepare() { throw new Error('unused'); },
    async refresh() { throw new Error('unused'); },
  };
}

test('resolves an explicit built-in connector', () => {
  const registry = new ConnectorRegistry();
  registry.register(connector('feishu-base'));
  assert.equal(registry.resolve('anything', 'feishu-base').type, 'feishu-base');
});

test('auto-detects exactly one connector', () => {
  const registry = new ConnectorRegistry();
  registry.register(connector('feishu-base', (source) => source.includes('/base/')));
  registry.register(connector('csv', (source) => source.endsWith('.csv')));
  assert.equal(registry.resolve('https://tenant.feishu.cn/base/abc?table=tbl').type, 'feishu-base');
});

test('refuses unknown and ambiguous sources', () => {
  const registry = new ConnectorRegistry();
  registry.register(connector('one', () => true));
  registry.register(connector('two', () => true));
  assert.throws(() => registry.resolve('source'), /multiple connectors/);
  assert.throws(() => new ConnectorRegistry().resolve('source'), /no connector/);
});
