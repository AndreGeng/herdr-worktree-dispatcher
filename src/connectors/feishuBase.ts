import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

import { digestJson, sha256File, utcNow } from '../batch/storage.js';
import { die } from '../utils/errors.js';
import { commandExists } from '../utils/process.js';
import type {
  AssetReference,
  ConnectorCheckResult,
  ConnectorContext,
  ConnectorTaskDraft,
  InspectRequest,
  MappingCandidate,
  PrepareRequest,
  PreparedSource,
  RefreshRequest,
  RefreshResult,
  SelectionCondition,
  SelectionCriteria,
  SelectionGroup,
  SemanticMappingProposal,
  SourceFacet,
  SourceField,
  SourceInspection,
  TaskConnector,
} from './types.js';

const SINGLE_ATTACHMENT_LIMIT = 100 * 1024 * 1024;
const BATCH_ATTACHMENT_LIMIT = 500 * 1024 * 1024;
const TEXT_LIMIT = 256 * 1024;

const ALIASES: Record<string, string[]> = {
  title: ['标题', '任务', '问题', '需求', 'title', 'subject', 'name'],
  description: ['问题描述', '任务描述', '需求描述', '描述', '详情', '内容', 'description', 'detail'],
  status: ['处理状态', '任务状态', '状态', '进度', 'status', 'state'],
  owner: ['跟进人', '负责人', '经办人', '执行人', 'owner', 'assignee'],
  priority: ['优先级', '紧急程度', '严重程度', 'priority', 'severity'],
  type: ['问题类型', '任务类型', '类型', '分类', 'type', 'category'],
  module: ['所属板块', '所属模块', '模块', '端', 'module', 'area'],
  notes: ['备注', '补充', '说明', 'notes', 'comment'],
  created_at: ['创建时间', '提交时间', 'createdat', 'created'],
  updated_at: ['更新时间', '修改时间', 'updatedat', 'updated', 'modified'],
  issue_id: ['问题编号', '任务编号', '工单号', 'issueid', 'ticket', 'id'],
  attachments: ['问题截图', '截图', '附件', '文件', '图片', 'image', 'attachment', 'file'],
};

const TYPE_HINTS: Record<string, Set<string>> = {
  title: new Set(['1', 'text', 'primary', 'rich_text']),
  description: new Set(['1', 'text', 'primary', 'rich_text', 'multiline']),
  status: new Set(['1', '3', '4', 'text', 'single_select', 'multi_select']),
  owner: new Set(['1', '11', '1003', 'text', 'person', 'multi_person', 'user']),
  priority: new Set(['1', '2', '3', 'text', 'number', 'single_select']),
  type: new Set(['1', '3', '4', 'text', 'single_select', 'multi_select']),
  module: new Set(['1', '3', '4', 'text', 'single_select', 'multi_select']),
  notes: new Set(['1', 'text', 'rich_text', 'multiline']),
  created_at: new Set(['5', '1001', 'date', 'created_time']),
  updated_at: new Set(['5', '1002', 'date', 'modified_time']),
  issue_id: new Set(['1', '2', '1005', 'text', 'number', 'autonumber']),
  attachments: new Set(['17', 'attachment']),
};

const ATTACHMENT_KEYS = ['file_token', 'token', 'fileToken'] as const;
const COMPARISON_OPERATORS: SourceField['supportedOperators'] = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'contains_any',
  'is_empty',
  'not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
];

interface BaseLocation {
  url: string;
  appToken: string;
  tableId: string;
  viewId: string;
}

interface FeishuField {
  field_id?: string;
  id?: string;
  field_name?: string;
  name?: string;
  type?: string | number;
  type_name?: string;
  ui_type?: string;
  is_primary?: boolean;
  [key: string]: unknown;
}

interface FeishuRecord {
  record_id?: string;
  id?: string;
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

interface NormalizedRecord {
  recordId: string;
  sourceIndex: number;
  fields: Record<string, unknown>;
  roles: Record<string, string[]>;
  normalizedFields: Record<string, string[]>;
}

export interface FeishuCommandRunner {
  run(command: string, args: string[]): string;
  exists(command: string): boolean;
}

const defaultRunner: FeishuCommandRunner = {
  run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
      die(`command failed (${result.status ?? 'unknown'}): ${command} ${args.join(' ')}${detail ? `\n${detail.slice(-1600)}` : ''}`);
    }
    return String(result.stdout || '');
  },
  exists: commandExists,
};

export class FeishuBaseConnector implements TaskConnector {
  readonly type = 'feishu-base';
  readonly version = '1';

  constructor(private readonly runner: FeishuCommandRunner = defaultRunner) {}

  canHandle(source: string): boolean {
    try {
      parseBaseUrl(source);
      return true;
    } catch {
      return false;
    }
  }

  async check(_context: ConnectorContext): Promise<ConnectorCheckResult> {
    if (!this.runner.exists('feishu')) {
      return {
        ready: false,
        problems: [{
          code: 'dependency_missing',
          message: 'feishu CLI is not installed',
          resolution: 'Install the organization-approved feishu CLI, then run feishu auth login.',
        }],
      };
    }
    try {
      const version = this.runner.run('feishu', ['--version']).trim();
      const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
      if (!match) {
        return { ready: false, problems: [{ code: 'version_unknown', message: `cannot parse feishu CLI version: ${version || 'empty'}` }] };
      }
      const numeric = Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]);
      if (numeric < 1_003_000) {
        return {
          ready: false,
          problems: [{
            code: 'version_unsupported',
            message: `feishu CLI ${match[0]} is too old; version 1.3.0 or newer is required`,
            resolution: 'Run the organization-approved feishu update command.',
          }],
        };
      }
      return { ready: true, problems: [] };
    } catch (error) {
      return {
        ready: false,
        problems: [{ code: 'dependency_error', message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async inspect(request: InspectRequest, _context: ConnectorContext): Promise<SourceInspection> {
    const location = parseBaseUrl(request.source);
    const { fields, records } = this.fetchLive(location);
    const mapping = inferMapping(fields, records, ['description']);
    const normalized = records.map((record, index) => normalizeRecord(record, mapping.resolved, index));
    const facets = ['status', 'priority', 'owner', 'type', 'module']
      .map((role) => buildFacet(role, normalized))
      .filter((facet): facet is SourceFacet => Boolean(facet));
    const attachments = attachmentPlan(normalized, mapping.resolved);
    const connectorState = {
      location,
      fields,
      records,
    };
    return {
      connector: this.type,
      connectorVersion: this.version,
      source: {
        connector: this.type,
        url: request.source,
        metadata: {
          app_token: location.appToken,
          table_id: location.tableId,
          view_id: location.viewId,
        },
      },
      inspectedAt: utcNow(),
      snapshot: digestJson({ fields, records }),
      recordCount: records.length,
      fields: fields.map((field) => ({
        id: fieldId(field),
        name: fieldName(field),
        type: fieldType(field),
        supportedOperators: COMPARISON_OPERATORS,
        representativeValues: representativeValues(records, fieldName(field)),
      })),
      facets,
      mapping,
      attachmentCount: attachments.length,
      attachmentBytes: attachments.reduce((total, item) => total + item.size, 0),
      warnings: [],
      selectionRequired: true,
      connectorState,
    };
  }

  async prepare(request: PrepareRequest, context: ConnectorContext): Promise<PreparedSource> {
    const state = request.inspection.connectorState as {
      location?: BaseLocation;
      fields?: FeishuField[];
      records?: FeishuRecord[];
    };
    const fields = state.fields || [];
    const records = state.records || [];
    if (records.length !== request.inspection.recordCount) die('inspection record state is incomplete');
    const requiredRoles = ['description', ...criteriaRoles(request.criteria)];
    const mapping = inferMapping(fields, records, requiredRoles, request.inspection.mapping.resolved);
    if (mapping.needsConfirmation) {
      die(`field mapping requires confirmation: ${mapping.ambiguousRoles.join(', ')}`);
    }
    const normalized = records.map((record, index) => normalizeRecord(record, mapping.resolved, index));
    const selected = normalized.filter((record) => matchWhere(record, request.criteria.where));
    sortRecords(selected, request.criteria);
    const selection = {
      mode: request.selectionMode,
      criteria: request.criteria,
      confirmedAt: utcNow(),
      digest: digestJson({ mode: request.selectionMode, criteria: request.criteria, snapshot: request.inspection.snapshot }),
    } as const;
    const assets = this.downloadAttachments(
      selected,
      mapping.resolved,
      context.batchDir,
      request.allowLargeAttachments,
    );
    const assetsByRecord = new Map<string, AssetReference[]>();
    for (const asset of assets) {
      const current = assetsByRecord.get(asset.sourceRecordId) || [];
      current.push(asset);
      assetsByRecord.set(asset.sourceRecordId, current);
    }
    const tasks: ConnectorTaskDraft[] = selected.map((record) => {
      const title = firstRole(record, 'title') || firstRole(record, 'issue_id') || record.recordId;
      return {
        sourceRecordId: record.recordId,
        title,
        description: firstRole(record, 'description') || title,
        priority: firstRole(record, 'priority') || undefined,
        status: firstRole(record, 'status') || undefined,
        owner: record.roles.owner || [],
        labels: [...(record.roles.type || []), ...(record.roles.module || [])],
        originalFields: record.fields,
        assets: assetsByRecord.get(record.recordId) || [],
      };
    });
    return {
      connector: this.type,
      connectorVersion: this.version,
      source: request.inspection.source,
      snapshot: request.inspection.snapshot,
      selection,
      sourceRecordCount: records.length,
      selectedRecordCount: tasks.length,
      skippedRecordCount: records.length - tasks.length,
      tasks,
      assets,
      connectorState: {
        ...state,
        mapping,
        selected_record_ids: tasks.map((task) => task.sourceRecordId),
      },
      warnings: [],
    };
  }

  async refresh(request: RefreshRequest, _context: ConnectorContext): Promise<RefreshResult> {
    const metadata = request.inspection.source.metadata;
    const location: BaseLocation = {
      url: request.inspection.source.url,
      appToken: String(metadata.app_token || ''),
      tableId: String(metadata.table_id || ''),
      viewId: String(metadata.view_id || ''),
    };
    try {
      const { fields, records } = this.fetchLive(location);
      const snapshot = digestJson({ fields, records });
      if (snapshot === request.inspection.snapshot) {
        return { state: 'unchanged', changes: [], requiresReconfirmation: false, snapshot };
      }
      return {
        state: 'changed',
        changes: [{ description: 'The Feishu Base fields or visible records changed after inspection.' }],
        requiresReconfirmation: true,
        snapshot,
      };
    } catch (error) {
      return {
        state: 'unavailable',
        changes: [{ description: error instanceof Error ? error.message : String(error) }],
        requiresReconfirmation: true,
      };
    }
  }

  private fetchLive(location: BaseLocation): { fields: FeishuField[]; records: FeishuRecord[] } {
    const fieldsPayload = parseJsonOutput(this.runner.run('feishu', [
      'bitable',
      'fields',
      location.appToken,
      location.tableId,
    ]));
    const fields = unwrapItems(fieldsPayload).items as FeishuField[];
    const records: FeishuRecord[] = [];
    let pageToken = '';
    for (;;) {
      const args = ['bitable', 'records', location.appToken, location.tableId, '--page-size', '500'];
      if (location.viewId) args.push('--view-id', location.viewId);
      if (pageToken) args.push('--page-token', pageToken);
      const page = unwrapItems(parseJsonOutput(this.runner.run('feishu', args)));
      records.push(...page.items as FeishuRecord[]);
      if (!page.hasMore) break;
      if (!page.pageToken) die('Feishu response says has_more but omitted page_token');
      pageToken = page.pageToken;
    }
    return { fields, records };
  }

  private downloadAttachments(
    records: NormalizedRecord[],
    mapping: Record<string, string | string[] | null>,
    batchDir: string,
    allowLarge: boolean,
  ): AssetReference[] {
    const plan = attachmentPlan(records, mapping);
    let plannedBytes = 0;
    for (const item of plan) {
      plannedBytes += item.size;
      if (!allowLarge && item.size > SINGLE_ATTACHMENT_LIMIT) {
        die(`attachment exceeds single-file limit: ${item.sourceRecordId}/${item.originalName} (${item.size} bytes)`);
      }
      if (!allowLarge && plannedBytes > BATCH_ATTACHMENT_LIMIT) {
        die(`attachments exceed batch limit (${plannedBytes} bytes)`);
      }
    }
    const assets: AssetReference[] = [];
    for (const item of plan) {
      const recordDir = join(batchDir, 'assets', sanitizeName(item.sourceRecordId, 'record'));
      mkdirSync(recordDir, { recursive: true, mode: 0o700 });
      const local = uniqueAssetPath(recordDir, sanitizeName(item.originalName, 'attachment'));
      if (item.sourcePath) {
        copyFileSync(item.sourcePath, local);
      } else {
        const resourceType = item.mime.startsWith('image/') ? 'image' : 'file';
        this.runner.run('feishu', ['fetch', item.token, '--type', resourceType, '--output', local]);
      }
      if (!existsSync(local)) die(`attachment download did not create file: ${local}`);
      chmodSync(local, 0o600);
      const actualSize = statSync(local).size;
      const kind = detectAssetKind(item.mime, item.originalName);
      assets.push({
        id: `${item.sourceRecordId}:${assets.length + 1}`,
        sourceRecordId: item.sourceRecordId,
        originalName: item.originalName,
        relativePath: relative(batchDir, local),
        mime: item.mime,
        size: actualSize,
        sha256: sha256File(local),
        required: true,
        kind,
        readingPolicy: kind === 'image'
          ? 'inspect-image'
          : kind === 'text'
            ? actualSize <= TEXT_LIMIT ? 'full-text' : 'bounded-head-tail'
            : 'metadata-only',
      });
    }
    return assets;
  }
}

export function parseBaseUrl(raw: string): BaseLocation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    die('expected an absolute Feishu/Lark Base URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') die('expected an absolute Feishu/Lark Base URL');
  if (!/(^|\.)feishu\.cn$|(^|\.)larksuite\.com$/i.test(parsed.hostname)) die('expected a Feishu/Lark host');
  const match = parsed.pathname.match(/\/base\/([^/?#]+)/);
  if (!match) die('URL does not contain /base/<app_token>');
  const tableId = parsed.searchParams.get('table') || '';
  if (!tableId) die('Base URL must include ?table=<table_id>');
  return {
    url: raw,
    appToken: match[1],
    tableId,
    viewId: parsed.searchParams.get('view') || '',
  };
}

export function parseJsonOutput(text: string): unknown {
  const clean = text.trim();
  try {
    return JSON.parse(clean);
  } catch {
    const starts = [...clean.matchAll(/[\[{]/g)].map((match) => match.index || 0);
    for (const start of starts) {
      for (let end = clean.length; end > start; end -= 1) {
        const last = clean[end - 1];
        if (last !== '}' && last !== ']') continue;
        try {
          return JSON.parse(clean.slice(start, end));
        } catch {
          // Continue scanning for a complete JSON value in noisy CLI output.
        }
      }
    }
  }
  die(`Feishu CLI did not return JSON: ${clean.slice(-500)}`);
}

function unwrapItems(payload: unknown): { items: unknown[]; hasMore: boolean; pageToken: string } {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
  const node = root && 'data' in root ? root.data : payload;
  if (Array.isArray(node)) return { items: node, hasMore: false, pageToken: '' };
  if (!node || typeof node !== 'object') die('unexpected Feishu list response');
  const record = node as Record<string, unknown>;
  const items = record.items ?? record.records ?? record.fields;
  if (!Array.isArray(items)) die('Feishu response has no items/records array');
  return {
    items,
    hasMore: Boolean(record.has_more),
    pageToken: String(record.page_token || ''),
  };
}

function fieldName(field: FeishuField): string {
  return String(field.field_name || field.name || field.field_id || '');
}

function fieldId(field: FeishuField): string {
  return String(field.field_id || field.id || fieldName(field));
}

function fieldType(field: FeishuField): string {
  return String(field.type_name || field.ui_type || field.type || '').toLowerCase();
}

function compactName(value: string): string {
  return value.replace(/[\s_\-—–/（）()[\]【】:：]+/g, '').toLowerCase();
}

function visibleValues(value: unknown): string[] {
  const result: string[] = [];
  const visit = (item: unknown): void => {
    if (item === null || item === undefined) return;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      result.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const preferred = ['name', 'en_name', 'text', 'value', 'full_name', 'display_name', 'email', 'link'];
      const present = preferred.filter((key) => record[key] !== undefined && record[key] !== '');
      if (present.length > 0) present.forEach((key) => visit(record[key]));
      else Object.entries(record)
        .filter(([key]) => !ATTACHMENT_KEYS.includes(key as typeof ATTACHMENT_KEYS[number]) && key !== 'url' && key !== 'tmp_url')
        .forEach(([, child]) => visit(child));
    }
  };
  visit(value);
  return [...new Set(result.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

function representativeValues(records: FeishuRecord[], name: string, limit = 20): string[] {
  const values: string[] = [];
  for (const record of records) {
    values.push(...visibleValues(record.fields?.[name]));
    if (values.length >= limit) break;
  }
  return values.slice(0, limit);
}

function scoreField(role: string, field: FeishuField, values: string[]): { score: number; evidence: string[] } {
  const normalized = compactName(fieldName(field));
  let score = 0;
  const evidence: string[] = [];
  for (const alias of ALIASES[role]) {
    const key = compactName(alias);
    if (normalized === key) {
      score += 80;
      evidence.push(`exact name:${alias}`);
      break;
    }
    if (key && normalized.includes(key)) {
      score += 45;
      evidence.push(`partial name:${alias}`);
      break;
    }
  }
  const type = fieldType(field);
  if (TYPE_HINTS[role].has(type)) {
    score += 20;
    evidence.push(`type:${type}`);
  }
  if (field.is_primary && (role === 'title' || role === 'description')) {
    score += 15;
    evidence.push('primary field');
  }
  const joined = values.join('|').toLowerCase();
  if (role === 'status' && /(已解决|处理中|待处理|closed|open)/i.test(joined)) {
    score += 12;
    evidence.push('status-like values');
  }
  if (role === 'priority' && /p[0-4]|最高|紧急|高|中|低/i.test(joined)) {
    score += 12;
    evidence.push('priority-like values');
  }
  if (role === 'attachments' && (type === '17' || type === 'attachment')) {
    score += 80;
    evidence.push('attachment field');
  }
  return { score, evidence };
}

export function inferMapping(
  fields: FeishuField[],
  records: FeishuRecord[],
  requiredRoles: string[],
  override?: Record<string, string | string[] | null>,
): SemanticMappingProposal {
  const required = new Set(requiredRoles);
  const candidates: Record<string, MappingCandidate[]> = {};
  const resolved: Record<string, string | string[] | null> = {};
  const ambiguous = new Set<string>();
  for (const role of Object.keys(ALIASES)) {
    const scored = fields.map((field) => {
      const score = scoreField(role, field, representativeValues(records, fieldName(field)));
      return { field: fieldName(field), fieldId: fieldId(field), score: score.score, evidence: score.evidence };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.field.localeCompare(b.field));
    candidates[role] = scored.slice(0, 5);
    if (role === 'attachments') {
      resolved[role] = fields.filter((field) => ['17', 'attachment'].includes(fieldType(field))).map(fieldName);
      continue;
    }
    const best = scored[0];
    const runnerUp = scored[1];
    const confident = Boolean(best && best.score >= 60 && (!runnerUp || best.score - runnerUp.score >= 15));
    resolved[role] = confident ? best.field : null;
    if (required.has(role) && !confident) ambiguous.add(role);
  }
  if (override) {
    for (const [role, value] of Object.entries(override)) {
      if (!(role in ALIASES) || value === null) continue;
      const values = Array.isArray(value) ? value : [value];
      const names = values.map((wanted) => {
        const match = fields.find((field) => wanted === fieldName(field) || wanted === fieldId(field));
        if (!match) die(`mapping references unknown field: ${wanted}`);
        return fieldName(match);
      });
      resolved[role] = Array.isArray(value) ? names : names[0];
      ambiguous.delete(role);
    }
  }
  return {
    resolved,
    candidates,
    requiredRoles: [...required].sort(),
    ambiguousRoles: [...ambiguous].sort(),
    needsConfirmation: ambiguous.size > 0,
  };
}

function normalizeRecord(
  record: FeishuRecord,
  mapping: Record<string, string | string[] | null>,
  index: number,
): NormalizedRecord {
  const fields = record.fields || {};
  const roles: Record<string, string[]> = {};
  for (const [role, mapped] of Object.entries(mapping)) {
    const names = Array.isArray(mapped) ? mapped : [mapped];
    roles[role] = [...new Set(names.flatMap((name) => name ? visibleValues(fields[name]) : []))];
  }
  return {
    recordId: String(record.record_id || record.id || `record-${index + 1}`),
    sourceIndex: index,
    fields,
    roles,
    normalizedFields: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, visibleValues(value)])),
  };
}

function criteriaRoles(criteria: SelectionCriteria): string[] {
  const roles = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      const object = node as Record<string, unknown>;
      if (typeof object.role === 'string') roles.add(object.role);
      Object.values(object).forEach(visit);
    }
  };
  visit(criteria);
  return [...roles];
}

function valuesForCondition(record: NormalizedRecord, condition: SelectionCondition): string[] {
  if (condition.role) return record.roles[condition.role] || [];
  if (condition.field) return record.normalizedFields[condition.field] || [];
  die('each condition must contain role or field');
}

function matchCondition(record: NormalizedRecord, condition: SelectionCondition): boolean {
  const values = valuesForCondition(record, condition);
  const folded = values.map((value) => value.toLocaleLowerCase());
  const needle = String(condition.value ?? '').toLocaleLowerCase();
  switch (condition.op) {
    case 'is_empty': return values.length === 0;
    case 'not_empty': return values.length > 0;
    case 'equals': return folded.includes(needle);
    case 'not_equals': return !folded.includes(needle);
    case 'contains': return folded.some((value) => value.includes(needle));
    case 'not_contains': return folded.every((value) => !value.includes(needle));
    case 'contains_any': {
      if (!Array.isArray(condition.values)) die('contains_any requires values[]');
      return condition.values.some((wanted) => folded.some((value) => value.includes(String(wanted).toLocaleLowerCase())));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      return values.some((value) => scalarCompare(
        value,
        condition.value,
        condition.op as 'gt' | 'gte' | 'lt' | 'lte',
      ));
  }
  die(`unsupported criteria operator: ${String(condition.op)}`);
}

function scalarCompare(left: string, right: unknown, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  const aNumber = Number(left);
  const bNumber = Number(right);
  const [a, b] = Number.isFinite(aNumber) && Number.isFinite(bNumber)
    ? [aNumber, bNumber]
    : [left.toLocaleLowerCase(), String(right).toLocaleLowerCase()];
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  return a <= b;
}

function matchWhere(record: NormalizedRecord, node?: SelectionGroup): boolean {
  if (!node || Object.keys(node).length === 0) return true;
  if (node.all) return node.all.every((child) => isGroup(child) ? matchWhere(record, child) : matchCondition(record, child));
  if (node.any) return node.any.some((child) => isGroup(child) ? matchWhere(record, child) : matchCondition(record, child));
  return matchCondition(record, node as SelectionCondition);
}

function isGroup(node: SelectionGroup | SelectionCondition): node is SelectionGroup {
  return 'all' in node || 'any' in node;
}

function priorityRank(values: string[]): [number, number] {
  if (values.length === 0) return [1, 999];
  const text = values[0].trim().toLowerCase();
  const p = text.match(/\bp([0-4])\b/);
  if (p) return [0, Number(p[1])];
  if (text === '高' || /(high|major)/.test(text)) return [0, 1];
  if (text === '中' || /(medium|normal)/.test(text)) return [0, 2];
  if (text === '低' || /(low|minor)/.test(text)) return [0, 3];
  if (/(最高|紧急|阻断|blocker|critical)/.test(text)) return [0, 0];
  if (/(最低|trivial)/.test(text)) return [0, 4];
  const numeric = Number(text);
  return Number.isFinite(numeric) ? [0, numeric] : [1, 999];
}

function sortRecords(records: NormalizedRecord[], criteria: SelectionCriteria): void {
  const specs = criteria.sort || [];
  for (const spec of [...specs].reverse()) {
    records.sort((left, right) => {
      const a = spec.role ? left.roles[spec.role] || [] : left.normalizedFields[spec.field || ''] || [];
      const b = spec.role ? right.roles[spec.role] || [] : right.normalizedFields[spec.field || ''] || [];
      const compared = spec.direction === 'semantic'
        ? compareTuple(priorityRank(a), priorityRank(b))
        : String(a[0] || '').localeCompare(String(b[0] || ''));
      return spec.direction === 'desc' ? -compared : compared;
    });
  }
}

function compareTuple(a: [number, number], b: [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

function buildFacet(role: string, records: NormalizedRecord[]): SourceFacet | undefined {
  const counts = new Map<string, number>();
  let mapped = false;
  for (const record of records) {
    if (role in record.roles) mapped = true;
    const values = record.roles[role] || [];
    if (values.length === 0) counts.set('未提供', (counts.get('未提供') || 0) + 1);
    else for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  }
  if (!mapped) return undefined;
  return {
    role,
    values: [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
  };
}

interface PlannedAttachment {
  sourceRecordId: string;
  field: string;
  token: string;
  originalName: string;
  size: number;
  mime: string;
  sourcePath?: string;
}

function attachmentPlan(
  records: NormalizedRecord[],
  mapping: Record<string, string | string[] | null>,
): PlannedAttachment[] {
  const mapped = mapping.attachments;
  const fields = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
  const result: PlannedAttachment[] = [];
  for (const record of records) {
    for (const field of fields) {
      const attachments = attachmentObjects(record.fields[field]);
      for (const [index, attachment] of attachments.entries()) {
        const token = String(attachment.file_token || attachment.token || attachment.fileToken || '');
        const originalName = String(attachment.name || `${field}-${index + 1}`);
        const sourcePath = typeof attachment.source_path === 'string' ? attachment.source_path : undefined;
        if (!token && !sourcePath) die(`attachment is missing a file token: ${record.recordId}/${originalName}`);
        result.push({
          sourceRecordId: record.recordId,
          field,
          token,
          originalName,
          size: Number(attachment.size || 0),
          mime: String(attachment.mime_type || attachment.type || guessMime(originalName)),
          sourcePath,
        });
      }
    }
  }
  return result;
}

function attachmentObjects(value: unknown): Array<Record<string, unknown>> {
  const hasToken = (item: unknown): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object' && ATTACHMENT_KEYS.some((key) => key in (item as Record<string, unknown>)));
  if (hasToken(value)) return [value];
  return Array.isArray(value) ? value.filter(hasToken) : [];
}

function sanitizeName(value: string, fallback: string): string {
  const name = basename(value.replaceAll('\\', '/'));
  const clean = name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, '-').replace(/^[.\-_]+|[.\-_]+$/g, '');
  return (clean || fallback).slice(0, 120);
}

function uniqueAssetPath(directory: string, name: string): string {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = join(directory, name);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(directory, `${stem}-${index}${extension}`);
    index += 1;
  }
  return candidate;
}

function guessMime(name: string): string {
  const extension = extname(name).toLowerCase();
  const known: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.pdf': 'application/pdf',
  };
  return known[extension] || 'application/octet-stream';
}

function detectAssetKind(mime: string, name: string): AssetReference['kind'] {
  const normalized = mime || guessMime(name);
  if (normalized.startsWith('image/')) return 'image';
  if (
    normalized.startsWith('text/')
    || ['application/json', 'application/xml', 'application/javascript'].includes(normalized)
  ) return 'text';
  return 'binary';
}

function firstRole(record: NormalizedRecord, role: string): string {
  return record.roles[role]?.[0] || '';
}

export function defaultFeishuRegistryConnector(): TaskConnector {
  return new FeishuBaseConnector();
}
