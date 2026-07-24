#!/usr/bin/env node
import { Command } from 'commander';

import { registerAdd } from './commands/add.js';
import { registerBatch } from './commands/batch.js';
import { registerConnector } from './commands/connector.js';
import { registerCleanupWorker } from './commands/cleanupWorker.js';
import { registerInit } from './commands/init.js';
import { registerInstall } from './commands/install.js';
import { registerMerge } from './commands/merge.js';
import { registerMessage } from './commands/message.js';
import { registerStats } from './commands/stats.js';
import { registerSource } from './commands/source.js';
import { registerTeam } from './commands/team.js';
import { registerTraceHook } from './commands/traceHook.js';
import { CliError } from './utils/errors.js';

const program = new Command();

program
  .name('herdr-worktree-dispatcher')
  .description('Dispatch coding tasks into temporary Herdr git worktrees')
  .showHelpAfterError()
  .exitOverride();

registerAdd(program);
registerConnector(program);
registerSource(program);
registerBatch(program);
registerInit(program);
registerInstall(program);
registerMerge(program);
registerMessage(program);
registerStats(program);
registerTeam(program);
registerTraceHook(program);
registerCleanupWorker(program);

program.command('cleanup').action(() => {
  throw new CliError('cleanup is not a public command; use add --merge for implementation tasks that should merge back');
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
  if (error && typeof error === 'object' && 'code' in error && String((error as { code: unknown }).code).startsWith('commander.')) {
    process.exit((error as { exitCode?: number }).exitCode ?? 1);
  }
  throw error;
}
