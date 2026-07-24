import type { Command } from 'commander';

import {
  batchStatus,
  dispatchBatch,
  previewBatch,
  renderReview,
  verifyBatch,
} from '../batch/manager.js';
import { cleanBatch } from '../batch/storage.js';
import { die } from '../utils/errors.js';
import { resolveSourceCwd } from './source.js';

interface BatchOptions {
  batch?: string;
  config?: string;
  profile?: string;
  confirm?: string;
  yes?: boolean;
}

export function registerBatch(program: Command): void {
  const batch = program.command('batch').description('Review, verify, and dispatch prepared task batches');

  batch.command('review').requiredOption('--batch <dir>').action((options: BatchOptions) => {
    const path = renderReview(options.batch || '');
    process.stdout.write(`${JSON.stringify({ status: 'rendered', review: path })}\n`);
  });

  batch.command('verify').requiredOption('--batch <dir>').action((options: BatchOptions) => {
    const result = verifyBatch(options.batch || '');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  });

  batch.command('preview')
    .requiredOption('--batch <dir>')
    .option('--config <path>')
    .option('--profile <name>')
    .action((options: BatchOptions) => {
      const result = previewBatch(options.batch || '', resolveSourceCwd(), {
        configFile: options.config,
        profile: options.profile,
      });
      process.stdout.write(`${JSON.stringify({
        status: 'previewed',
        batch: options.batch,
        digest: result.digest,
        agent: result.agent,
        earliest_ready_wave: result.earliestReadyWave,
        ready: result.tasks.filter((task) => task.state === 'ready').length,
        blocked: result.tasks.filter((task) => task.state === 'blocked').length,
        preview: `${options.batch}/DISPATCH.md`,
      })}\n`);
    });

  batch.command('dispatch')
    .requiredOption('--batch <dir>')
    .requiredOption('--confirm <digest>')
    .option('--config <path>')
    .option('--profile <name>')
    .action((options: BatchOptions) => {
      const outputs = dispatchBatch(
        options.batch || '',
        resolveSourceCwd(),
        options.confirm || '',
        { configFile: options.config, profile: options.profile },
      );
      process.stdout.write(`${JSON.stringify({
        status: 'batch_dispatched',
        batch: options.batch,
        tasks: outputs,
      })}\n`);
    });

  batch.command('status').requiredOption('--batch <dir>').action((options: BatchOptions) => {
    process.stdout.write(`${JSON.stringify(batchStatus(options.batch || ''), null, 2)}\n`);
  });

  batch.command('clean')
    .requiredOption('--batch <dir>')
    .option('--yes', 'Confirm deletion of this exact retained batch')
    .action((options: BatchOptions) => {
      if (!options.yes) die('batch clean requires --yes');
      cleanBatch(options.batch || '', resolveSourceCwd());
      process.stdout.write(`${JSON.stringify({ status: 'cleaned', batch: options.batch })}\n`);
    });
}
