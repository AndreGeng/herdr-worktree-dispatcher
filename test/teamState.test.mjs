import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addRunningWorker, listTeamEvents, markWorkerDone, markWorkerFailed, readTeamState, recordLeaderNotification, recordWorkerChecklistUpdate, recordWorkerFinish, recordWorkerPlan, writeTeamState } from '../dist/team/state.js';

function state() {
  return {
    mode: 'team',
    team_id: 'team_1',
    profile: 'engineering',
    source_cwd: '/repo',
    source_branch: 'main',
    base_commit: 'abc',
    shared_workspace_id: 'ws_1',
    shared_worktree_path: '/repo-wt',
    branch: 'worktree/task',
    merge_token_path: '/tmp/merge.json',
    merge_command: 'herdr-worktree-dispatcher merge --token /tmp/merge.json',
    team_token_path: '/tmp/team.json',
    herdr_bin: 'herdr',
    layout: 'right',
    merge_mode: 'rebase',
    leader: {
      member_id: 'leader_1',
      team_id: 'team_1',
      agent_run_id: 'agent_leader',
      agent_name: 'leader',
      agent_role: 'leader',
      agent_kind: 'pi',
      workspace_id: 'ws_1',
      worktree_path: '/repo-wt',
      status: 'running',
      started_at: '2026-07-03T00:00:00.000Z',
    },
    workers: [],
    created_at: '2026-07-03T00:00:00.000Z',
    updated_at: '2026-07-03T00:00:00.000Z',
  };
}

function worker(id) {
  return {
    member_id: id,
    team_id: 'team_1',
    agent_run_id: `agent_${id}`,
    parent_agent_run_id: 'agent_leader',
    agent_name: id,
    agent_role: 'worker',
    worker_role: 'reviewer',
    agent_kind: 'codex',
    workspace_id: 'ws_1',
    worktree_path: '/repo-wt',
    status: 'running',
    started_at: '2026-07-03T00:00:01.000Z',
    launch_mode: 'split',
    tab_id: 'tab_worker_1',
    pane_id: 'pane_worker_1',
  };
}

test('team state writes, reads, locks, and releases active worker', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'team-state-')), 'team.json');
  const initial = state();
  writeTeamState(path, initial);
  assert.equal(readTeamState(path).team_id, 'team_1');

  const locked = addRunningWorker(initial, worker('worker_1'));
  assert.equal(locked.active_worker_id, 'worker_1');
  assert.equal(locked.events[0].kind, 'worker_spawned');
  assert.throws(() => addRunningWorker(locked, worker('worker_2')), /running worker/);

  const done = markWorkerDone(locked, 'worker_1');
  assert.equal(done.active_worker_id, undefined);
  assert.equal(done.workers[0].status, 'done');
  assert.equal(done.events.at(-1).kind, 'worker_done');
  assert.equal(done.workers[0].tab_id, 'tab_worker_1');
  assert.equal(done.workers[0].pane_id, 'pane_worker_1');
});

test('team state marks failed workers and releases active worker', () => {
  const locked = addRunningWorker(state(), worker('worker_1'));

  const failed = markWorkerFailed(locked, 'worker_1', 42);

  assert.equal(failed.active_worker_id, undefined);
  assert.equal(failed.workers[0].status, 'failed');
  assert.equal(failed.workers[0].exit_code, 42);
  assert.equal(failed.events.at(-1).kind, 'worker_failed');
  assert.match(failed.events.at(-1).message, /exit=42/);
});

test('team state records structured worker finish', () => {
  const locked = addRunningWorker(state(), worker('worker_1'));

  const finished = recordWorkerFinish(locked, 'worker_1', {
    changed: 'updated team command flow',
    verified: 'npm test',
    blockers: 'none',
    recommended_next: 'tester because behavior changed',
  });

  assert.equal(finished.workers[0].finish_result.changed, 'updated team command flow');
  assert.equal(finished.events.at(-1).kind, 'worker_finished');
  assert.match(finished.events.at(-1).message, /changed updated team command flow/);
  assert.equal(finished.events.at(-1).worker_role, 'reviewer');
});

test('team state records leader notification outcome', () => {
  const locked = addRunningWorker(state(), worker('worker_1'));
  const done = markWorkerDone(locked, 'worker_1');

  const notified = recordLeaderNotification(done, 'worker_1', { ok: true, method: 'pane', detail: 'w2:p1' });
  const failed = recordLeaderNotification(notified, 'worker_1', { ok: false, method: 'pane', detail: 'pane not found' });

  assert.equal(notified.events.at(-1).kind, 'leader_notified');
  assert.equal(notified.events.at(-1).message, 'pane: w2:p1');
  assert.equal(failed.events.at(-1).kind, 'leader_notify_failed');
  assert.equal(failed.events.at(-1).message, 'pane: pane not found');
});

test('team state records and updates worker checklist', () => {
  const locked = addRunningWorker(state(), worker('worker_1'));

  const planned = recordWorkerPlan(locked, 'worker_1', ['inspect paths', 'implement change', 'run focused test'], 'inspecting');
  assert.equal(planned.workers[0].checklist.items.length, 3);
  assert.equal(planned.workers[0].checklist.items[0].done, false);
  assert.equal(planned.events.at(-1).kind, 'worker_plan');
  assert.match(planned.events.at(-1).message, /\[ \] inspect paths/);
  assert.match(planned.events.at(-1).message, /current: inspecting/);

  const updated = recordWorkerChecklistUpdate(planned, 'worker_1', [1, 2], 'running focused test');
  assert.equal(updated.workers[0].checklist.items[0].done, true);
  assert.equal(updated.workers[0].checklist.items[1].done, true);
  assert.equal(updated.workers[0].checklist.items[2].done, false);
  assert.equal(updated.events.at(-1).kind, 'worker_update');
  assert.match(updated.events.at(-1).message, /\[x\] inspect paths/);
  assert.match(updated.events.at(-1).message, /\[ \] run focused test/);
});

test('team state accepts up to ten checklist items', () => {
  const locked = addRunningWorker(state(), worker('worker_1'));
  const tenItems = Array.from({ length: 10 }, (_, index) => `step ${index + 1}`);

  const planned = recordWorkerPlan(locked, 'worker_1', tenItems, 'starting');

  assert.equal(planned.workers[0].checklist.items.length, 10);
  assert.throws(() => recordWorkerPlan(locked, 'worker_1', [...tenItems, 'step 11'], 'starting'), /at most 10 items/);
});

test('done records missing finish event when worker exits without finish', () => {
  const locked = addRunningWorker(state(), { ...worker('worker_1'), log_file: '/tmp/worker.log', last_output: 'last lines' });

  const done = markWorkerDone(locked, 'worker_1');

  assert.equal(done.events.at(-2).kind, 'worker_done_without_finish');
  assert.match(done.events.at(-2).message, /missing finish/);
  assert.match(done.events.at(-2).message, /\/tmp\/worker\.log/);
  assert.equal(done.events.at(-1).kind, 'worker_done');
});

test('team state lists bounded structured team events after a sequence', () => {
  let current = recordWorkerPlan(addRunningWorker(state(), worker('worker_1')), 'worker_1', ['inspect', 'implement'], 'starting');
  for (let index = 0; index < 105; index += 1) {
    current = recordWorkerChecklistUpdate(current, 'worker_1', [1], `step ${index}`);
  }

  assert.equal(current.events.length, 100);
  assert.equal(current.events[0].seq, 8);
  assert.deepEqual(
    listTeamEvents(current, 104).map((event) => event.message),
    ['[x] inspect\n[ ] implement\ncurrent: step 102', '[x] inspect\n[ ] implement\ncurrent: step 103', '[x] inspect\n[ ] implement\ncurrent: step 104'],
  );
});
