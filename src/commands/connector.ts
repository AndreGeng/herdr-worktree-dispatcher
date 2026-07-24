import type { Command } from 'commander';

import { createConnectorRegistry } from '../connectors/index.js';
import { resolveSourceCwd } from './source.js';

export function registerConnector(program: Command): void {
  const connector = program.command('connector').description('Inspect built-in external task connectors');

  connector.command('list').description('List built-in connectors').action(() => {
    const registry = createConnectorRegistry();
    process.stdout.write(`${JSON.stringify({
      connectors: registry.list().map((item) => ({ type: item.type, version: item.version })),
    }, null, 2)}\n`);
  });

  connector.command('describe').description('Describe one built-in connector')
    .argument('<type>')
    .action((type: string) => {
      const selected = createConnectorRegistry().get(type);
      process.stdout.write(`${JSON.stringify({
        type: selected.type,
        version: selected.version,
        read_only: true,
        operations: ['check', 'inspect', 'prepare', 'refresh'],
      }, null, 2)}\n`);
    });

  connector.command('check').description('Check connector dependencies')
    .argument('<type>')
    .action(async (type: string) => {
      const selected = createConnectorRegistry().get(type);
      const sourceCwd = resolveSourceCwd();
      const result = await selected.check({ sourceCwd, batchDir: '' });
      process.stdout.write(`${JSON.stringify({ connector: type, ...result }, null, 2)}\n`);
      if (!result.ready) process.exitCode = 1;
    });
}
