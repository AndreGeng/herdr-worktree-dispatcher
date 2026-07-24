import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { TeamChecklistItem, TeamEventKind, TeamFinishResult, TeamMember, TeamState } from './types.js';
import { die } from '../utils/errors.js';
import { slugify } from '../utils/text.js';

export function teamStateRoot(): string {
  return join(process.env.TMPDIR || '/tmp', 'herdr-worktree-dispatcher-teams');
}

export function createTeamId(label: string): string {
  return `team_${slugify(label)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function teamStatePath(teamId: string): string {
  return join(teamStateRoot(), `${teamId}.json`);
}

export function readTeamState(path: string): TeamState {
  if (!existsSync(path)) die(`team token not found: ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    die(`team state is not valid JSON: ${path}`);
  }
  const state = parsed as Partial<TeamState>;
  for (const key of ['mode', 'team_id', 'shared_workspace_id', 'shared_worktree_path', 'leader', 'workers'] as const) {
    if (!state[key]) die(`team state missing ${key}`);
  }
  if (state.mode !== 'team') die(`invalid team state mode: ${state.mode || 'empty'}`);
  if (!Array.isArray(state.workers)) die('team state workers must be an array');
  return state as TeamState;
}

export function writeTeamState(path: string, state: TeamState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2)}\n`);
}

export function addRunningWorker(state: TeamState, worker: TeamMember): TeamState {
  if (state.active_worker_id) die(`team already has a running worker: ${state.active_worker_id}`);
  return recordTeamEvent({
    ...state,
    workers: [...state.workers, worker],
    active_worker_id: worker.member_id,
  }, worker, 'worker_spawned', `spawned ${formatWorkerLabel(worker)}`);
}

export function markWorkerDone(state: TeamState, workerId: string): TeamState {
  return markWorkerFinished(state, workerId, { status: 'done' });
}

export function markWorkerFailed(state: TeamState, workerId: string, exitCode?: number): TeamState {
  return markWorkerFinished(state, workerId, { status: 'failed', exitCode });
}

export function recordWorkerPlan(state: TeamState, workerId: string, items: string[], current?: string): TeamState {
  const checklistItems = normalizeChecklistItems(items);
  if (checklistItems.length < 1) die('worker plan requires at least one item');
  if (checklistItems.length > 10) die('worker plan supports at most 10 items');
  const updatedAt = new Date().toISOString();
  let found = false;
  let matchedWorker: TeamMember | undefined;
  const workers = state.workers.map((worker) => {
    if (worker.member_id !== workerId) return worker;
    found = true;
    matchedWorker = worker;
    return { ...worker, checklist: { items: checklistItems, current, updated_at: updatedAt }, last_update: formatChecklistUpdate(checklistItems, current), last_update_at: updatedAt };
  });
  if (!found) die(`worker not found: ${workerId}`);
  return recordTeamEvent({ ...state, workers }, matchedWorker, 'worker_plan', formatChecklistUpdate(checklistItems, current));
}

export function recordWorkerChecklistUpdate(state: TeamState, workerId: string, doneIndexes: number[], current?: string): TeamState {
  const updatedAt = new Date().toISOString();
  const done = new Set(doneIndexes);
  let found = false;
  let updatedWorker: TeamMember | undefined;
  let updatedItems: TeamChecklistItem[] = [];
  const workers = state.workers.map((worker) => {
    if (worker.member_id !== workerId) return worker;
    found = true;
    if (!worker.checklist) die(`worker has no plan: ${workerId}`);
    updatedItems = worker.checklist.items.map((item, index) => done.has(index + 1) ? { ...item, done: true } : item);
    updatedWorker = { ...worker, checklist: { items: updatedItems, current, updated_at: updatedAt }, last_update: formatChecklistUpdate(updatedItems, current), last_update_at: updatedAt };
    return updatedWorker;
  });
  if (!found) die(`worker not found: ${workerId}`);
  return recordTeamEvent({ ...state, workers }, updatedWorker, 'worker_update', formatChecklistUpdate(updatedItems, current));
}

export function recordWorkerFinish(state: TeamState, workerId: string, input: Omit<TeamFinishResult, 'created_at'>): TeamState {
  let found = false;
  const createdAt = new Date().toISOString();
  let updatedWorker: TeamMember | undefined;
  const finishResult = { ...input, created_at: createdAt };
  const workers = state.workers.map((worker) => {
    if (worker.member_id !== workerId) return worker;
    found = true;
    updatedWorker = { ...worker, finish_result: finishResult };
    return updatedWorker;
  });
  if (!found) die(`worker not found: ${workerId}`);
  return recordTeamEvent(
    { ...state, workers },
    updatedWorker,
    'worker_finished',
    `changed ${input.changed}; verified ${input.verified}; blockers ${input.blockers}; recommended_next ${input.recommended_next}`,
  );
}

export function recordLeaderNotification(state: TeamState, workerId: string, input: { ok: boolean; method: string; detail: string }): TeamState {
  const worker = state.workers.find((item) => item.member_id === workerId);
  if (!worker) die(`worker not found: ${workerId}`);
  const kind = input.ok ? 'leader_notified' : 'leader_notify_failed';
  const message = `${input.method}: ${input.detail}`;
  return recordTeamEvent(state, worker, kind, message);
}

function markWorkerFinished(state: TeamState, workerId: string, input: { status: 'done' | 'failed'; exitCode?: number }): TeamState {
  let found = false;
  const completedAt = new Date().toISOString();
  let matchedWorker: TeamMember | undefined;
  const workers = state.workers.map((worker) => {
    if (worker.member_id !== workerId) return worker;
    found = true;
    matchedWorker = worker;
    return { ...worker, status: input.status, completed_at: completedAt, exit_code: input.exitCode };
  });
  if (!found) die(`worker not found: ${workerId}`);
  let nextState: TeamState = {
    ...state,
    workers,
    active_worker_id: state.active_worker_id === workerId ? undefined : state.active_worker_id,
  };
  if (input.status === 'done' && matchedWorker && !matchedWorker.finish_result) {
    nextState = recordTeamEvent(
      nextState,
      matchedWorker,
      'worker_done_without_finish',
      `missing finish${matchedWorker.log_file ? `; log ${matchedWorker.log_file}` : ''}${matchedWorker.last_output ? `; last_output ${matchedWorker.last_output}` : ''}`,
    );
  }
  const message = input.status === 'failed'
    ? `failed${input.exitCode !== undefined ? ` exit=${input.exitCode}` : ''}`
    : 'done';
  return recordTeamEvent(nextState, matchedWorker, input.status === 'failed' ? 'worker_failed' : 'worker_done', message);
}

export function listTeamEvents(state: TeamState, sinceSeq = 0): NonNullable<TeamState['events']> {
  return (state.events || []).filter((event) => event.seq > sinceSeq);
}

function recordTeamEvent(state: TeamState, worker: TeamMember | undefined, kind: TeamEventKind, message: string): TeamState {
  const previous = state.events || [];
  const lastSeq = previous.reduce((max, event) => Math.max(max, event.seq), 0);
  const event = {
    seq: lastSeq + 1,
    kind,
    worker_id: worker?.member_id,
    worker_role: worker?.worker_role,
    agent_kind: worker?.agent_kind,
    message,
    created_at: new Date().toISOString(),
  };
  return { ...state, events: [...previous, event].slice(-100) };
}

function normalizeChecklistItems(items: string[]): TeamChecklistItem[] {
  return items.map((item) => item.trim()).filter(Boolean).map((text) => ({ text, done: false }));
}

function formatChecklistUpdate(items: TeamChecklistItem[], current: string | undefined): string {
  const lines = items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`);
  if (current) lines.push(`current: ${current}`);
  return lines.join('\n');
}

function formatWorkerLabel(worker: TeamMember): string {
  return `${worker.worker_role || worker.agent_role}(${worker.agent_kind})`;
}
