import type { AgentKind } from '../trace/types.js';

export interface TeamRole {
  role: string;
  name: string;
  description: string;
  agent?: string;
  prompt?: string;
  prompt_file?: string;
  output?: string;
  success?: string;
  emoji?: string;
  color?: string;
  vibe?: string;
  tools?: string[];
  handoff?: string;
}

export interface TeamProfile {
  name: string;
  leaderAgent: string;
  defaultWorkerAgent?: string;
  workerAgentPool?: string[];
  maxActiveWorkers: number;
  roles: TeamRole[];
  workerAgents: Record<string, string>;
}

export type TeamMemberStatus = 'running' | 'done' | 'failed';

export interface TeamUpdateEvent {
  message: string;
  created_at: string;
  kind?: 'update';
}

export interface TeamChecklistItem {
  text: string;
  done: boolean;
}

export interface TeamChecklist {
  items: TeamChecklistItem[];
  current?: string;
  updated_at: string;
}

export type TeamEventKind = 'worker_spawned' | 'worker_plan' | 'worker_update' | 'worker_finished' | 'worker_done_without_finish' | 'worker_done' | 'worker_failed' | 'leader_notified' | 'leader_notify_failed';

export interface TeamFinishResult {
  changed: string;
  verified: string;
  blockers: string;
  recommended_next: string;
  created_at: string;
}

export interface TeamEvent {
  seq: number;
  kind: TeamEventKind;
  worker_id?: string;
  worker_role?: string;
  agent_kind?: AgentKind;
  message: string;
  created_at: string;
}

export interface TeamMember {
  member_id: string;
  team_id: string;
  agent_run_id: string;
  parent_agent_run_id?: string;
  agent_name: string;
  agent_role: 'leader' | 'worker';
  worker_role?: string;
  agent_kind: AgentKind;
  workspace_id: string;
  worktree_path: string;
  status: TeamMemberStatus;
  started_at: string;
  completed_at?: string;
  prompt_file?: string;
  launch_mode?: 'interactive' | 'background' | 'visible' | 'tab' | 'split';
  log_file?: string;
  tab_id?: string;
  pane_id?: string;
  last_update?: string;
  last_update_at?: string;
  last_output?: string;
  checklist?: TeamChecklist;
  finish_result?: TeamFinishResult;
  update_events?: TeamUpdateEvent[];
  pid?: number;
  exit_code?: number;
}

export interface TeamState {
  mode: 'team';
  team_id: string;
  profile: string;
  source_cwd: string;
  source_branch: string;
  base_commit: string;
  shared_workspace_id: string;
  shared_worktree_path: string;
  branch: string;
  merge_token_path: string;
  merge_command?: string;
  team_token_path: string;
  herdr_bin: string;
  config_file?: string;
  project_config_file?: string;
  config_profile?: string;
  language?: string;
  layout: 'right' | 'down';
  merge_mode: 'rebase' | 'merge';
  leader: TeamMember;
  workers: TeamMember[];
  events?: TeamEvent[];
  active_worker_id?: string;
  created_at: string;
  updated_at: string;
}
