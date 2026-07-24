import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { loadConfig } from '../config/config.js';
import type { ConnectorTaskDraft, PreparedSource, SourceInspection } from '../connectors/types.js';
import { runAdd } from '../commands/add.js';
import { die } from '../utils/errors.js';
import { firstCommandToken } from '../utils/process.js';
import { slugify } from '../utils/text.js';
import {
  assertBatchDir,
  digestJson,
  internalPath,
  readJson,
  sha256File,
  utcNow,
  writeJson,
} from './storage.js';
import {
  TASK_BUNDLE_SCHEMA,
  draftToTask,
  type BatchPreview,
  type BatchPreviewTask,
  type BatchTask,
  type BatchVerification,
  type TaskBundle,
} from './types.js';

export interface PreviewSelection {
  configFile?: string;
  profile?: string;
}

export function initializeInspectionBatch(batchDir: string, inspection: SourceInspection): void {
  mkdirSync(internalPath(batchDir, ''), { recursive: true, mode: 0o700 });
  writeJson(internalPath(batchDir, 'inspection.json'), inspection);
  renderInspectionReview(batchDir, inspection);
}

export function prepareBatch(batchDir: string, prepared: PreparedSource, inspection: SourceInspection): TaskBundle {
  const tasksDir = join(batchDir, 'tasks');
  mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
  const tasks: BatchTask[] = prepared.tasks.map((draft, index) => {
    const slug = slugify(draft.title || draft.sourceRecordId);
    const promptFile = join(tasksDir, `${String(index + 1).padStart(3, '0')}-${slugify(draft.sourceRecordId)}-${slug}.md`);
    writeFileSync(promptFile, renderTaskPrompt(draft, prepared, batchDir), { mode: 0o600 });
    return draftToTask(draft, promptFile, slug);
  });
  const now = utcNow();
  const bundle: TaskBundle = {
    schema: TASK_BUNDLE_SCHEMA,
    batchId: basename(batchDir),
    createdAt: now,
    updatedAt: now,
    source: prepared.source,
    connector: { type: prepared.connector, version: prepared.connectorVersion },
    snapshot: prepared.snapshot,
    selection: prepared.selection,
    sourceRecordCount: prepared.sourceRecordCount,
    selectedRecordCount: prepared.selectedRecordCount,
    skippedRecordCount: prepared.skippedRecordCount,
    tasks,
    assets: prepared.assets,
    warnings: prepared.warnings,
  };
  writeJson(internalPath(batchDir, 'prepared.json'), prepared);
  writeJson(internalPath(batchDir, 'bundle.json'), bundle);
  renderBatchReview(batchDir, inspection, bundle);
  return bundle;
}

export function renderReview(batchDir: string): string {
  const resolved = assertBatchDir(batchDir);
  const inspection = readJson<SourceInspection>(internalPath(resolved, 'inspection.json'));
  if (!existsSync(internalPath(resolved, 'bundle.json'))) {
    return renderInspectionReview(resolved, inspection);
  }
  const bundle = readJson<TaskBundle>(internalPath(resolved, 'bundle.json'));
  return renderBatchReview(resolved, inspection, bundle);
}

export function verifyBatch(batchDir: string): BatchVerification {
  const resolved = assertBatchDir(batchDir);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(internalPath(resolved, 'bundle.json'))) errors.push('batch has not been prepared');
  if (!existsSync(internalPath(resolved, 'prepared.json'))) errors.push('prepared source state is missing');
  if (errors.length > 0) return writeVerification(resolved, errors, warnings, undefined);
  const bundle = readJson<TaskBundle>(internalPath(resolved, 'bundle.json'));
  if (bundle.schema !== TASK_BUNDLE_SCHEMA) errors.push(`unsupported bundle schema: ${bundle.schema}`);
  if (!bundle.selection?.digest) errors.push('selection is not confirmed');
  if (bundle.tasks.length !== bundle.selectedRecordCount) errors.push('task count does not match selected record count');
  const ids = bundle.tasks.map((task) => task.id);
  if (ids.length !== new Set(ids).size) errors.push('duplicate task id');
  const idSet = new Set(ids);
  for (const task of bundle.tasks) {
    if (!existsSync(task.promptFile)) {
      errors.push(`missing task prompt: ${task.promptFile}`);
    } else {
      const prompt = readFileSync(task.promptFile, 'utf8');
      if (prompt.includes('ATTACHMENT_OBSERVATION_REQUIRED')) {
        errors.push(`image attachment observation is incomplete: ${task.id}`);
      }
    }
    for (const dependency of task.dependsOn) {
      if (!idSet.has(dependency)) errors.push(`task ${task.id} depends on unknown task ${dependency}`);
      const parent = bundle.tasks.find((candidate) => candidate.id === dependency);
      if (parent && task.wave <= parent.wave) errors.push(`task ${task.id} must be in a later wave than ${dependency}`);
    }
    for (const conflict of task.conflictsWith) {
      if (!idSet.has(conflict)) errors.push(`task ${task.id} conflicts with unknown task ${conflict}`);
    }
  }
  if (hasDependencyCycle(bundle.tasks)) errors.push('task dependency graph contains a cycle');
  for (const asset of bundle.assets) {
    const path = join(resolved, asset.relativePath);
    if (!existsSync(path)) errors.push(`missing attachment: ${asset.relativePath}`);
    else if (sha256File(path) !== asset.sha256) errors.push(`attachment hash mismatch: ${asset.relativePath}`);
  }
  const digest = errors.length === 0 ? contentDigest(bundle, resolved) : undefined;
  return writeVerification(resolved, errors, warnings, digest, bundle);
}

export function previewBatch(
  batchDir: string,
  sourceCwd: string,
  selection: PreviewSelection,
): BatchPreview {
  const resolved = assertBatchDir(batchDir);
  const verification = verifyBatch(resolved);
  if (!verification.valid) die(`batch verification failed: ${verification.errors.join('; ')}`);
  const refreshPath = internalPath(resolved, 'refresh.json');
  if (!existsSync(refreshPath)) die('source refresh is required before preview');
  const refresh = readJson<{ state?: string; snapshot?: string; requiresReconfirmation?: boolean }>(refreshPath);
  if (refresh.state !== 'unchanged' || refresh.requiresReconfirmation) {
    die('source changed or could not be refreshed; inspect and confirm the selection again');
  }
  const bundle = readJson<TaskBundle>(internalPath(resolved, 'bundle.json'));
  if (refresh.snapshot && refresh.snapshot !== bundle.snapshot) die('refresh snapshot does not match the prepared bundle');
  const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
  const config = loadConfig({
    herdrBin,
    configFile: selection.configFile,
    profile: selection.profile,
    sourceCwd,
  });
  const agent = firstCommandToken(config.agentCommand);
  const tasks: BatchPreviewTask[] = bundle.tasks.map((task) => {
    const images = task.assets.filter((asset) => asset.kind === 'image');
    let state: BatchPreviewTask['state'] = 'ready';
    let blockedReason: string | undefined;
    if (task.status === 'merged') state = 'merged';
    else if (task.status === 'dispatched') state = 'already_dispatched';
    else {
      const incomplete = task.dependsOn.filter((dependency) =>
        bundle.tasks.find((candidate) => candidate.id === dependency)?.status !== 'merged');
      if (incomplete.length > 0) {
        state = 'blocked';
        blockedReason = `waiting for merged dependencies: ${incomplete.join(', ')}`;
      }
    }
    if (state === 'ready' && images.length > 0 && agent !== 'codex') {
      state = 'blocked';
      blockedReason = `runtime '${agent}' has no verified image-input path; use Codex or a future tested capability`;
    }
    return {
      id: task.id,
      title: task.title,
      priority: task.priority,
      wave: task.wave,
      state,
      blockedReason,
      agent,
      profile: selection.profile,
      branchLabel: task.slug,
      promptFile: task.promptFile,
      assetCount: task.assets.length,
      imageCount: images.length,
    };
  });
  const readyWaves = tasks.filter((task) => task.state === 'ready').map((task) => task.wave);
  const base = {
    version: 1 as const,
    generatedAt: utcNow(),
    batchId: bundle.batchId,
    agent,
    profile: selection.profile,
    earliestReadyWave: readyWaves.length > 0 ? Math.min(...readyWaves) : undefined,
    tasks,
  };
  const digest = digestJson({
    contentDigest: verification.contentDigest,
    agent,
    profile: selection.profile,
    tasks: tasks.map(({ id, wave, state, blockedReason, branchLabel, assetCount, imageCount }) => ({
      id, wave, state, blockedReason, branchLabel, assetCount, imageCount,
    })),
  });
  const preview: BatchPreview = { ...base, digest };
  writeJson(internalPath(resolved, 'preview.json'), preview);
  renderBatchPreview(resolved, preview);
  return preview;
}

export function dispatchBatch(
  batchDir: string,
  sourceCwd: string,
  confirmDigest: string,
  selection: PreviewSelection,
): Array<ReturnType<typeof runAdd>> {
  const resolved = assertBatchDir(batchDir);
  const preview = previewBatch(resolved, sourceCwd, selection);
  if (preview.digest !== confirmDigest) die('preview confirmation digest does not match current batch contents');
  if (preview.earliestReadyWave === undefined) die('batch has no ready tasks to dispatch');
  const bundle = readJson<TaskBundle>(internalPath(resolved, 'bundle.json'));
  const ready = preview.tasks.filter((task) => task.state === 'ready' && task.wave === preview.earliestReadyWave);
  const outputs: Array<ReturnType<typeof runAdd>> = [];
  for (const item of ready) {
    const task = bundle.tasks.find((candidate) => candidate.id === item.id);
    if (!task) die(`preview references unknown task: ${item.id}`);
    const prompt = readFileSync(task.promptFile, 'utf8');
    const assets = task.assets.map((asset) => ({
      sourcePath: join(resolved, asset.relativePath),
      name: asset.originalName,
      image: asset.kind === 'image',
    }));
    const output = runAdd([prompt], {
      merge: true,
      name: task.slug,
      profile: selection.profile,
      config: selection.configFile,
      assets,
      batchDir: resolved,
      batchTaskId: task.id,
    }, false);
    if (!output) die(`dispatcher returned no output for task: ${task.id}`);
    task.status = 'dispatched';
    task.dispatch = {
      branch: output.branch,
      worktreePath: output.worktree_path,
      workspaceId: output.workspace_id,
      agentName: output.agent_name,
      mergeToken: output.cleanup_token,
      mergeCommand: output.merge_command,
    };
    writeJson(internalPath(resolved, 'bundle.json'), { ...bundle, updatedAt: utcNow() });
    outputs.push(output);
  }
  renderBatchReview(
    resolved,
    readJson<SourceInspection>(internalPath(resolved, 'inspection.json')),
    bundle,
  );
  return outputs;
}

export function batchStatus(batchDir: string): Record<string, unknown> {
  const resolved = assertBatchDir(batchDir);
  const bundle = existsSync(internalPath(resolved, 'bundle.json'))
    ? readJson<TaskBundle>(internalPath(resolved, 'bundle.json'))
    : undefined;
  return {
    batch: resolved,
    prepared: Boolean(bundle),
    tasks: bundle?.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      wave: task.wave,
      status: task.status,
      branch: task.dispatch?.branch,
      worktree_path: task.dispatch?.worktreePath,
      merge_token: task.dispatch?.mergeToken,
    })) || [],
  };
}

export function markBatchTaskMerged(batchDir: string, taskId: string): void {
  const resolved = assertBatchDir(batchDir);
  const bundle = readJson<TaskBundle>(internalPath(resolved, 'bundle.json'));
  const task = bundle.tasks.find((candidate) => candidate.id === taskId);
  if (!task) die(`batch task not found: ${taskId}`);
  task.status = 'merged';
  writeJson(internalPath(resolved, 'bundle.json'), { ...bundle, updatedAt: utcNow() });
}

function renderInspectionReview(batchDir: string, inspection: SourceInspection): string {
  const lines = [
    '# External task source inspection',
    '',
    `- Connector: \`${inspection.connector}\` v${inspection.connectorVersion}`,
    `- Source: ${inspection.source.url}`,
    `- Records visible in source: ${inspection.recordCount}`,
    `- Attachments declared: ${inspection.attachmentCount}`,
    `- Declared attachment bytes: ${inspection.attachmentBytes}`,
    '- Selection: **confirmation required**',
    '',
    'No records have been selected and no attachments have been downloaded.',
    'Provide explicit criteria, or explicitly confirm all visible records.',
    '',
    '## Field mapping',
    '',
    '| Role | Resolved field | State | Evidence |',
    '|---|---|---|---|',
  ];
  for (const role of Object.keys(inspection.mapping.resolved)) {
    const resolved = inspection.mapping.resolved[role];
    const best = inspection.mapping.candidates[role]?.[0];
    lines.push(`| ${role} | ${Array.isArray(resolved) ? resolved.join(', ') : resolved || '—'} | ${inspection.mapping.ambiguousRoles.includes(role) ? 'confirm' : 'inferred'} | ${(best?.evidence || []).join('; ') || '—'} |`);
  }
  lines.push('', '## Facets', '');
  for (const facet of inspection.facets) {
    lines.push(`### ${facet.role}`, '', ...facet.values.map((item) => `- ${item.value}: ${item.count}`), '');
  }
  const path = join(batchDir, 'REVIEW.md');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return path;
}

function renderBatchReview(batchDir: string, inspection: SourceInspection, bundle: TaskBundle): string {
  const lines = [
    '# External worker task batch',
    '',
    `- Connector: \`${bundle.connector.type}\` v${bundle.connector.version}`,
    `- Source: ${bundle.source.url}`,
    `- Source records: ${bundle.sourceRecordCount}`,
    `- Selected: ${bundle.selectedRecordCount}`,
    `- Skipped: ${bundle.skippedRecordCount}`,
    `- Selection mode: \`${bundle.selection.mode}\``,
    `- Selection digest: \`${bundle.selection.digest}\``,
    '',
    '## Confirmed criteria',
    '',
    '```json',
    JSON.stringify(bundle.selection.criteria, null, 2),
    '```',
    '',
    '## Tasks',
    '',
    '| Order | Record | Priority | Wave | Assets | State | Title |',
    '|---:|---|---|---:|---:|---|---|',
    ...bundle.tasks.map((task, index) =>
      `| ${index + 1} | ${task.sourceRecordId} | ${task.priority || '—'} | ${task.wave} | ${task.assets.length} | ${task.status} | ${task.title.replaceAll('|', '／')} |`),
    '',
    '## Attachment status',
    '',
    `- Files: ${bundle.assets.length}`,
    `- Images requiring actual visual observations: ${bundle.assets.filter((asset) => asset.kind === 'image').length}`,
    `- Total bytes: ${bundle.assets.reduce((total, asset) => total + asset.size, 0)}`,
    '',
    '## Field mapping',
    '',
    '| Role | Field |',
    '|---|---|',
    ...Object.entries(inspection.mapping.resolved).map(([role, field]) =>
      `| ${role} | ${Array.isArray(field) ? field.join(', ') : field || '—'} |`),
    '',
    'Run `batch verify`, then `batch preview`. No worktree is created until `batch dispatch` receives the exact preview digest.',
  ];
  const path = join(batchDir, 'REVIEW.md');
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return path;
}

function renderTaskPrompt(draft: ConnectorTaskDraft, prepared: PreparedSource, batchDir: string): string {
  const observations = draft.assets.length === 0
    ? ['- None']
    : draft.assets.map((asset) => asset.kind === 'image'
      ? `- ATTACHMENT_OBSERVATION_REQUIRED: \`${asset.relativePath}\` — inspect the actual image and replace this line with a factual observation.`
      : `- \`${asset.relativePath}\`: ${asset.kind}, ${asset.readingPolicy}, ${asset.size} bytes.`);
  const repoInstructions = readRepoInstructions(dirname(dirname(dirname(batchDir))));
  return `# ${draft.title}

## Traceability

- Source: ${prepared.source.url}
- Connector: \`${prepared.connector}\`
- Source record: \`${draft.sourceRecordId}\`
- Priority: ${draft.priority || '未提供'}
- Owner: ${draft.owner.join(', ') || '未提供'}
- Status: ${draft.status || '未提供'}

## Objective

${draft.description}

## Requirements and constraints

- Investigate the current implementation before changing it.
- Keep the change scoped to this source record.
- Do not fabricate a fix. If the issue cannot be reproduced or safely fixed, create a Markdown investigation report with evidence and blockers.
- Obey the repository boundaries and commit-message requirements reproduced below.

## Attachment observations

${observations.join('\n')}

## Original source fields

\`\`\`json
${JSON.stringify(draft.originalFields, null, 2)}
\`\`\`

## Repository instructions

${repoInstructions}

## Acceptance criteria

- The reported behavior is reproduced or investigated with evidence.
- The concrete outcome described above is implemented without unrelated refactoring.
- Relevant behavior has focused verification.

## Verification

- Run only checks directly related to this task.
- Do not run a repository-wide Vitest suite unless the repository instructions and user explicitly require it.

## Worker delivery contract

- Produce actual file changes or a Markdown investigation report.
- Commit only this task's changes using the repository's commit-message rules.
- Run the dispatcher lifecycle merge command only after a real commit exists.
`;
}

function readRepoInstructions(repo: string): string {
  const parts: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const path = join(repo, name);
    if (existsSync(path)) parts.push(`### ${name}\n\n${readFileSync(path, 'utf8').slice(0, 24_000)}`);
  }
  return parts.join('\n\n') || 'No repository instruction file was found; preserve existing conventions.';
}

function renderBatchPreview(batchDir: string, preview: BatchPreview): void {
  const lines = [
    '# Batch dispatch preview',
    '',
    `- Batch: \`${preview.batchId}\``,
    `- Agent: \`${preview.agent}\``,
    `- Profile: ${preview.profile ? `\`${preview.profile}\`` : 'default'}`,
    `- Earliest ready wave: ${preview.earliestReadyWave ?? 'none'}`,
    `- Confirmation digest: \`${preview.digest}\``,
    '',
    '| Record | Priority | Wave | State | Assets | Images | Branch label | Title |',
    '|---|---|---:|---|---:|---:|---|---|',
    ...preview.tasks.map((task) =>
      `| ${task.id} | ${task.priority || '—'} | ${task.wave} | ${task.state}${task.blockedReason ? `: ${task.blockedReason}` : ''} | ${task.assetCount} | ${task.imageCount} | ${task.branchLabel} | ${task.title.replaceAll('|', '／')} |`),
    '',
    'Dispatch requires the exact digest above. Any prompt, attachment, criteria, relationship, or runtime change invalidates it.',
  ];
  writeFileSync(join(batchDir, 'DISPATCH.md'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

function writeVerification(
  batchDir: string,
  errors: string[],
  warnings: string[],
  contentDigestValue?: string,
  bundle?: TaskBundle,
): BatchVerification {
  const tasks = bundle?.tasks || [];
  const result: BatchVerification = {
    version: 1,
    verifiedAt: utcNow(),
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      tasks: tasks.length,
      assets: bundle?.assets.length || 0,
      ready: tasks.filter((task) => task.status === 'ready' || task.status === 'prepared').length,
      blocked: tasks.filter((task) => task.status === 'blocked').length,
      dispatched: tasks.filter((task) => task.status === 'dispatched').length,
      merged: tasks.filter((task) => task.status === 'merged').length,
    },
    contentDigest: contentDigestValue,
  };
  writeJson(internalPath(batchDir, 'verification.json'), result);
  return result;
}

function contentDigest(bundle: TaskBundle, batchDir: string): string {
  return digestJson({
    schema: bundle.schema,
    source: bundle.source,
    connector: bundle.connector,
    snapshot: bundle.snapshot,
    selection: bundle.selection,
    tasks: bundle.tasks.map((task) => ({
      id: task.id,
      sourceRecordId: task.sourceRecordId,
      title: task.title,
      slug: task.slug,
      priority: task.priority,
      wave: task.wave,
      dependsOn: task.dependsOn,
      conflictsWith: task.conflictsWith,
      suspectedDuplicateOf: task.suspectedDuplicateOf,
      promptSha256: existsSync(task.promptFile) ? sha256File(task.promptFile) : '',
      assets: task.assets.map((asset) => ({ relativePath: asset.relativePath, sha256: asset.sha256 })),
    })),
    assetHashes: bundle.assets.map((asset) => ({
      relativePath: asset.relativePath,
      expected: asset.sha256,
      actual: existsSync(join(batchDir, asset.relativePath)) ? sha256File(join(batchDir, asset.relativePath)) : '',
    })),
  });
}

function hasDependencyCycle(tasks: BatchTask[]): boolean {
  const dependencies = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}
