import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Command } from 'commander';

import { initializeInspectionBatch, prepareBatch, renderReview } from '../batch/manager.js';
import { assertBatchDir, createBatchDir, internalPath, readJson, writeJson } from '../batch/storage.js';
import { createConnectorRegistry } from '../connectors/index.js';
import type {
  PreparedSource,
  SelectionCriteria,
  SemanticMappingProposal,
  SourceInspection,
} from '../connectors/types.js';
import { die } from '../utils/errors.js';

interface InspectOptions {
  connector?: string;
  output?: string;
}

interface PrepareOptions {
  batch?: string;
  criteria?: string;
  allVisibleRecords?: boolean;
  mapping?: string;
  allowLargeAttachments?: boolean;
}

interface RefreshOptions {
  batch?: string;
}

export function registerSource(program: Command): void {
  const source = program.command('source').description('Import external task sources through built-in connectors');

  source.command('inspect')
    .description('Inspect a source without selecting records, downloading attachments, or creating worktrees')
    .argument('<source>')
    .option('--connector <type>', 'Explicit connector type')
    .option('--output <dir>', 'Explicit batch output directory')
    .action((sourceValue: string, options: InspectOptions) => runSourceInspect(sourceValue, options));

  source.command('prepare')
    .description('Prepare a confirmed source selection as a worker task batch')
    .requiredOption('--batch <dir>', 'Batch directory returned by source inspect')
    .option('--criteria <path>', 'Confirmed criteria JSON file')
    .option('--all-visible-records', 'Explicitly confirm every record visible in the inspected source')
    .option('--mapping <path>', 'Batch-local semantic mapping override JSON')
    .option('--allow-large-attachments', 'Allow attachments above the default size limits')
    .action((options: PrepareOptions) => runSourcePrepare(options));

  source.command('refresh')
    .description('Check whether the source changed after preparation')
    .requiredOption('--batch <dir>', 'Prepared batch directory')
    .action((options: RefreshOptions) => runSourceRefresh(options));
}

export async function runSourceInspect(sourceValue: string, options: InspectOptions): Promise<void> {
  const sourceCwd = resolveSourceCwd();
  const batchDir = createBatchDir(sourceCwd, sourceValue, options.output);
  const connector = createConnectorRegistry().resolve(sourceValue, options.connector);
  const check = await connector.check({ sourceCwd, batchDir });
  if (!check.ready) {
    die(check.problems.map((problem) => `${problem.message}${problem.resolution ? ` (${problem.resolution})` : ''}`).join('; '));
  }
  const inspection = await connector.inspect({ source: sourceValue }, { sourceCwd, batchDir });
  initializeInspectionBatch(batchDir, inspection);
  process.stdout.write(`${JSON.stringify({
    status: 'selection_required',
    batch: batchDir,
    connector: connector.type,
    source_records: inspection.recordCount,
    attachments_declared: inspection.attachmentCount,
    mapping_confirmation_required: inspection.mapping.needsConfirmation,
    ambiguous_roles: inspection.mapping.ambiguousRoles,
    review: resolve(batchDir, 'REVIEW.md'),
  })}\n`);
}

export async function runSourcePrepare(options: PrepareOptions): Promise<void> {
  const batchDir = assertBatchDir(options.batch || '');
  if (Boolean(options.criteria) === Boolean(options.allVisibleRecords)) {
    die('source prepare requires exactly one of --criteria or --all-visible-records');
  }
  const inspection = readJson<SourceInspection>(internalPath(batchDir, 'inspection.json'));
  if (options.mapping) applyMappingOverride(inspection.mapping, readJson<Record<string, string | string[]>>(resolve(options.mapping)));
  const criteria: SelectionCriteria = options.criteria
    ? readJson<SelectionCriteria>(resolve(options.criteria), 'criteria')
    : {
        where: {},
        sort: inspection.mapping.resolved.priority
          ? [{ role: 'priority', direction: 'semantic' }]
          : [],
      };
  const connector = createConnectorRegistry().get(inspection.connector);
  const prepared = await connector.prepare({
    inspection,
    criteria,
    selectionMode: options.allVisibleRecords ? 'all_visible_records' : 'criteria',
    allowLargeAttachments: Boolean(options.allowLargeAttachments),
  }, {
    sourceCwd: resolveSourceCwd(),
    batchDir,
  });
  writeJson(internalPath(batchDir, 'inspection.json'), inspection);
  const bundle = prepareBatch(batchDir, prepared, inspection);
  process.stdout.write(`${JSON.stringify({
    status: 'prepared',
    batch: batchDir,
    selected: bundle.selectedRecordCount,
    skipped: bundle.skippedRecordCount,
    attachments: bundle.assets.length,
    review: resolve(batchDir, 'REVIEW.md'),
    tasks_dir: resolve(batchDir, 'tasks'),
  })}\n`);
}

export async function runSourceRefresh(options: RefreshOptions): Promise<void> {
  const batchDir = assertBatchDir(options.batch || '');
  if (!existsSync(internalPath(batchDir, 'prepared.json'))) die('batch has not been prepared');
  const inspection = readJson<SourceInspection>(internalPath(batchDir, 'inspection.json'));
  const prepared = readJson<PreparedSource>(internalPath(batchDir, 'prepared.json'));
  const connector = createConnectorRegistry().get(inspection.connector);
  const result = await connector.refresh({ inspection, prepared }, {
    sourceCwd: resolveSourceCwd(),
    batchDir,
  });
  writeJson(internalPath(batchDir, 'refresh.json'), result);
  renderReview(batchDir);
  process.stdout.write(`${JSON.stringify({ batch: batchDir, ...result })}\n`);
  if (result.requiresReconfirmation) process.exitCode = 2;
}

function applyMappingOverride(
  mapping: SemanticMappingProposal,
  override: Record<string, string | string[]>,
): void {
  for (const [role, field] of Object.entries(override)) {
    if (!(role in mapping.resolved)) die(`unknown semantic mapping role: ${role}`);
    mapping.resolved[role] = field;
    mapping.ambiguousRoles = mapping.ambiguousRoles.filter((item) => item !== role);
  }
  mapping.needsConfirmation = mapping.ambiguousRoles.length > 0;
}

export function resolveSourceCwd(): string {
  if (process.env.HERDR_WORKSPACE_CWD) return process.env.HERDR_WORKSPACE_CWD;
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON) as {
        workspace_cwd?: string;
        focused_pane_cwd?: string;
      };
      if (context.workspace_cwd) return context.workspace_cwd;
      if (context.focused_pane_cwd) return context.focused_pane_cwd;
    } catch {
      // Ignore malformed plugin context and use PWD.
    }
  }
  return process.cwd();
}
