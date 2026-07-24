import type {
  AssetReference,
  ConfirmedSelection,
  ConnectorTaskDraft,
  PreparedSource,
  SourceDescriptor,
  SourceInspection,
} from '../connectors/types.js';

export const TASK_BUNDLE_SCHEMA = 'herdr.task-bundle/v1';

export type BatchTaskStatus = 'prepared' | 'ready' | 'blocked' | 'dispatched' | 'merged' | 'failed';

export interface BatchTask {
  id: string;
  sourceRecordId: string;
  title: string;
  slug: string;
  promptFile: string;
  priority?: string;
  wave: number;
  dependsOn: string[];
  conflictsWith: string[];
  suspectedDuplicateOf?: string;
  assets: AssetReference[];
  status: BatchTaskStatus;
  blockedReason?: string;
  dispatch?: {
    branch: string;
    worktreePath: string;
    workspaceId: string;
    agentName: string;
    mergeToken?: string;
    mergeCommand?: string;
  };
}

export interface TaskBundle {
  schema: typeof TASK_BUNDLE_SCHEMA;
  batchId: string;
  createdAt: string;
  updatedAt: string;
  source: SourceDescriptor;
  connector: {
    type: string;
    version: string;
  };
  snapshot: string;
  selection: ConfirmedSelection;
  sourceRecordCount: number;
  selectedRecordCount: number;
  skippedRecordCount: number;
  tasks: BatchTask[];
  assets: AssetReference[];
  warnings: string[];
}

export interface BatchVerification {
  version: 1;
  verifiedAt: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: {
    tasks: number;
    assets: number;
    ready: number;
    blocked: number;
    dispatched: number;
    merged: number;
  };
  contentDigest?: string;
}

export interface BatchPreviewTask {
  id: string;
  title: string;
  priority?: string;
  wave: number;
  state: 'ready' | 'blocked' | 'already_dispatched' | 'merged';
  blockedReason?: string;
  agent: string;
  profile?: string;
  branchLabel: string;
  promptFile: string;
  assetCount: number;
  imageCount: number;
}

export interface BatchPreview {
  version: 1;
  generatedAt: string;
  batchId: string;
  agent: string;
  profile?: string;
  earliestReadyWave?: number;
  tasks: BatchPreviewTask[];
  digest: string;
}

export interface BatchDocument {
  inspection: SourceInspection;
  prepared?: PreparedSource;
  bundle?: TaskBundle;
}

export function draftToTask(draft: ConnectorTaskDraft, promptFile: string, slug: string): BatchTask {
  return {
    id: draft.sourceRecordId,
    sourceRecordId: draft.sourceRecordId,
    title: draft.title,
    slug,
    promptFile,
    priority: draft.priority,
    wave: 1,
    dependsOn: [],
    conflictsWith: [],
    assets: draft.assets,
    status: 'prepared',
  };
}
