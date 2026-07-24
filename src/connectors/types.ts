export type JsonObject = Record<string, unknown>;

export type SelectionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'contains_any'
  | 'is_empty'
  | 'not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface SelectionCondition {
  role?: string;
  field?: string;
  op: SelectionOperator;
  value?: unknown;
  values?: unknown[];
}

export interface SelectionGroup {
  all?: Array<SelectionGroup | SelectionCondition>;
  any?: Array<SelectionGroup | SelectionCondition>;
}

export interface SelectionCriteria {
  where?: SelectionGroup;
  sort?: Array<{
    role?: string;
    field?: string;
    direction?: 'asc' | 'desc' | 'semantic';
  }>;
}

export interface ConnectorContext {
  sourceCwd: string;
  batchDir: string;
}

export interface ConnectorCheckResult {
  ready: boolean;
  problems: Array<{
    code: string;
    message: string;
    resolution?: string;
  }>;
}

export interface SourceDescriptor {
  connector: string;
  url: string;
  metadata: JsonObject;
}

export interface SourceField {
  id: string;
  name: string;
  type: string;
  supportedOperators: SelectionOperator[];
  representativeValues: string[];
}

export interface MappingCandidate {
  field: string;
  fieldId: string;
  score: number;
  evidence: string[];
}

export interface SemanticMappingProposal {
  resolved: Record<string, string | string[] | null>;
  candidates: Record<string, MappingCandidate[]>;
  requiredRoles: string[];
  ambiguousRoles: string[];
  needsConfirmation: boolean;
}

export interface SourceFacet {
  role: string;
  field?: string;
  values: Array<{ value: string; count: number }>;
}

export interface SourceInspection {
  connector: string;
  connectorVersion: string;
  source: SourceDescriptor;
  inspectedAt: string;
  snapshot: string;
  recordCount: number;
  fields: SourceField[];
  facets: SourceFacet[];
  mapping: SemanticMappingProposal;
  attachmentCount: number;
  attachmentBytes: number;
  warnings: string[];
  selectionRequired: true;
  connectorState: JsonObject;
}

export interface AssetReference {
  id: string;
  sourceRecordId: string;
  originalName: string;
  relativePath: string;
  mime: string;
  size: number;
  sha256: string;
  required: boolean;
  kind: 'image' | 'text' | 'binary';
  readingPolicy: 'inspect-image' | 'full-text' | 'bounded-head-tail' | 'metadata-only';
}

export interface ConnectorTaskDraft {
  sourceRecordId: string;
  sourceUrl?: string;
  title: string;
  description: string;
  priority?: string;
  status?: string;
  owner: string[];
  labels: string[];
  originalFields: JsonObject;
  assets: AssetReference[];
}

export interface ConfirmedSelection {
  mode: 'criteria' | 'all_visible_records';
  criteria: SelectionCriteria;
  confirmedAt: string;
  digest: string;
}

export interface PreparedSource {
  connector: string;
  connectorVersion: string;
  source: SourceDescriptor;
  snapshot: string;
  selection: ConfirmedSelection;
  sourceRecordCount: number;
  selectedRecordCount: number;
  skippedRecordCount: number;
  tasks: ConnectorTaskDraft[];
  assets: AssetReference[];
  connectorState: JsonObject;
  warnings: string[];
}

export interface SourceChange {
  sourceRecordId?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
  description: string;
}

export interface RefreshResult {
  state: 'unchanged' | 'changed' | 'unavailable';
  changes: SourceChange[];
  requiresReconfirmation: boolean;
  snapshot?: string;
}

export interface InspectRequest {
  source: string;
}

export interface PrepareRequest {
  inspection: SourceInspection;
  criteria: SelectionCriteria;
  selectionMode: ConfirmedSelection['mode'];
  allowLargeAttachments: boolean;
}

export interface RefreshRequest {
  inspection: SourceInspection;
  prepared: PreparedSource;
}

export interface TaskConnector {
  readonly type: string;
  readonly version: string;
  canHandle(source: string): boolean;
  check(context: ConnectorContext): Promise<ConnectorCheckResult>;
  inspect(request: InspectRequest, context: ConnectorContext): Promise<SourceInspection>;
  prepare(request: PrepareRequest, context: ConnectorContext): Promise<PreparedSource>;
  refresh(request: RefreshRequest, context: ConnectorContext): Promise<RefreshResult>;
}
