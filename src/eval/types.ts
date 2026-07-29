export type EvalArm = 'solo' | 'team';
export type EvalGrade = 'pass' | 'fail' | 'error' | 'timeout';
export type EvalGateStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'INVALID';

export interface EvalTaskFixture {
  repo?: string;
  commit?: string;
  url?: string;
}

export interface EvalTask {
  id: string;
  name: string;
  category: 'bug-fix' | 'feature' | 'refactor' | 'investigation';
  difficulty: 'easy' | 'medium' | 'hard';
  fixture: EvalTaskFixture;
  prompt: string;
  acceptance?: string[];
  limits?: {
    wall_seconds?: number;
    max_retries?: number;
  };
  graders: EvalGraderDef[];
  critical?: boolean;
}

export interface EvalGraderCommand {
  type: 'command';
  command: string;
  label?: string;
}

export interface EvalGraderHiddenCommand {
  type: 'hidden-command';
  command: string;
  label?: string;
}

export interface EvalGraderFileExists {
  type: 'file-exists';
  path: string;
  label?: string;
}

export interface EvalGraderNoFileChanges {
  type: 'no-file-changes';
  paths: string[];
  label?: string;
}

export type EvalGraderDef = EvalGraderCommand | EvalGraderHiddenCommand | EvalGraderFileExists | EvalGraderNoFileChanges;

export interface EvalSuite {
  name: string;
  version: string;
  description?: string;
  defaults: {
    wall_seconds: number;
    repetitions: number;
    agent: string;
    agent_args?: string[];
    team_profile?: string;
    team_agent_args?: string[];
  };
  tasks: EvalTask[];
}

export interface EvalRunConfig {
  suite_name: string;
  arm: EvalArm;
  task_id: string;
  repetition: number;
  base_commit?: string;
  source_url?: string;
  agent: string;
  agent_args: string[];
  team_profile?: string;
  team_leader_agent?: string;
  team_leader_args?: string[];
  team_worker_agent?: string;
  team_worker_args?: string[];
  team_agent_args?: string[];
  wall_seconds: number;
}

export interface EvalRunResult {
  config: EvalRunConfig;
  status: EvalGrade;
  wall_ms: number;
  merged: boolean;
  patch_path?: string;
  merge_log_path?: string;
  trace_path?: string;
  team_state_path?: string;
  error?: string;
  artifact_dir: string;
}

export interface EvalGradeResult {
  task_id: string;
  arm: EvalArm;
  repetition: number;
  overall: EvalGrade;
  graders: Array<{
    label: string;
    type: string;
    passed: boolean;
    output?: string;
    error?: string;
  }>;
  quality?: EvalQualityMetrics;
}

export interface EvalQualityMetrics {
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  test_files_added: number;
  test_lines_added: number;
  acceptance_matched: number;
  acceptance_total: number;
  quality_score: number;
  scoring_details?: Array<{
    category: string;
    points: number;
    max_points: number;
    reason: string;
  }>;
}

export interface EvalTaskComparison {
  task_id: string;
  task_name: string;
  category: string;
  difficulty: string;
  critical: boolean;
  solo: EvalArmStats;
  team: EvalArmStats;
  delta: number;
  winner: EvalArm | 'tie';
}

export interface EvalArmStats {
  pass_rate: number;
  pass_count: number;
  total_count: number;
  median_wall_ms: number;
  p95_wall_ms: number;
  mean_wall_ms: number;
  timeout_count: number;
  error_count: number;
}

export interface EvalComparison {
  suite_name: string;
  timestamp: string;
  task_count: number;
  repetitions: number;
  overall: {
    solo_pass_rate: number;
    team_pass_rate: number;
    delta: number;
    team_wins: number;
    solo_wins: number;
    ties: number;
  };
  cost: {
    solo_median_wall_ms: number;
    team_median_wall_ms: number;
    wall_ratio: number;
    solo_total_wall_ms: number;
    team_total_wall_ms: number;
  };
  tasks: EvalTaskComparison[];
}

export interface EvalReport {
  comparison: EvalComparison;
  markdown: string;
}

export interface EvalGateResult {
  status: EvalGateStatus;
  reason: string;
  comparison: EvalComparison;
}

export interface EvalManifest {
  eval_run_id: string;
  suite_name: string;
  suite_version: string;
  dispatcher_version: string;
  dispatcher_commit?: string;
  timestamp: string;
  config_hash: string;
  arms: EvalArm[];
  task_ids: string[];
  repetitions: number;
}
