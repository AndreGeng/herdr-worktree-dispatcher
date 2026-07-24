import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildTeamPreflightReport, buildVisibleWorkerCommand, formatBriefWorker, formatLastLeaderNotification, formatLeaderWorkerChecklist, formatLeaderWorkerDone, formatLeaderWorkerFinish, formatTeamEventsBrief, formatTeamPreflightReport, formatTeamSpawnBrief, formatWorkerLabel, getLastLeaderNotification, notifyLeader, runTeamFinish } from '../dist/commands/team.js';
import { writeTeamState } from '../dist/team/state.js';

test('visible worker command is non-interactive and marks completion', () => {
  const command = buildVisibleWorkerCommand({
    command: 'HERDR_TRACE_RUN_ID=run_1 codex exec --color always "$(cat prompt.md)"',
    doneCommand: "'bin/herdr-worktree-dispatcher' team done --token '/tmp/team.json' --worker 'worker_1'",
    workerLabel: 'implementer(codex)',
    worktreePath: '/repo/worktree',
    taskText: 'Implement readable worker logs',
    logFile: '/repo/worktree/.herdr-worktree-dispatcher/runs/worker_1.log',
  });

  assert.match(command, /worker implementer\(codex\) started/);
  assert.match(command, /worktree: \/repo\/worktree/);
  assert.match(command, /--- agent output ---/);
  assert.match(command, /tee -a '\/repo\/worktree\/\.herdr-worktree-dispatcher\/runs\/worker_1\.log'/);
  assert.doesNotMatch(command, /team progress/);
  assert.match(command, /--- worker result ---/);
  assert.match(command, /team done --token '\/tmp\/team\.json' --worker 'worker_1' --exit-code "\$status" --log-file '\/repo\/worktree\/\.herdr-worktree-dispatcher\/runs\/worker_1\.log'/);
});

test('worker label includes runtime', () => {
  assert.equal(
    formatWorkerLabel({ member_id: 'worker_1', agent_role: 'worker', worker_role: 'implementer', agent_kind: 'codex' }),
    'implementer(codex)',
  );
});

test('team spawn brief exposes worker id and active-worker commands', () => {
  const output = formatTeamSpawnBrief({
    member_id: 'worker_implementer_abc123',
    team_id: 'team_1',
    agent_run_id: 'agent_1',
    agent_name: 'wt-implementer',
    agent_role: 'worker',
    worker_role: 'implementer',
    agent_kind: 'codex',
    workspace_id: 'w1',
    worktree_path: '/repo/worktree',
    status: 'running',
    started_at: '2026-07-03T00:00:00.000Z',
    pane_id: 'w2R:p2',
  });

  assert.match(output, /dispatched implementer\(codex\)/);
  assert.match(output, /worker worker_implementer_abc123/);
  assert.match(output, /pane w2R:p2/);
  assert.match(output, /diagnostic team status --brief --token "\$TEAM_TOKEN"/);
  assert.doesNotMatch(output, /team watch/);
  assert.doesNotMatch(output, /team dashboard/);
  assert.doesNotMatch(output, /--worker w2R/);
});

test('team status worker brief formats multiline update readably', () => {
  assert.equal(
    formatBriefWorker({
      member_id: 'worker_1',
      team_id: 'team_1',
      agent_run_id: 'agent_1',
      agent_name: 'wt-implementer',
      agent_role: 'worker',
      worker_role: 'implementer',
      agent_kind: 'opencode',
      workspace_id: 'w1',
      worktree_path: '/repo/worktree',
      status: 'running',
      started_at: '2026-07-03T00:00:00.000Z',
      pane_id: 'w20:p2',
      log_file: '/repo/worktree/.herdr-worktree-dispatcher/runs/worker.log',
      last_update: '[x] 检查示例应用消息列表\n[ ] 实现滚动到底部按钮\ncurrent: 正在实现组件',
    }),
    'implementer(opencode): running\npane: w20:p2\nlog: /repo/worktree/.herdr-worktree-dispatcher/runs/worker.log\nupdate:\n  [x] 检查示例应用消息列表\n  [ ] 实现滚动到底部按钮\n  current: 正在实现组件',
  );
});

test('leader worker done notification keeps pane reference before cleanup', () => {
  assert.equal(
    formatLeaderWorkerDone({ member_id: 'worker_1', agent_role: 'worker', worker_role: 'tester', agent_kind: 'codex', pane_id: 'w2J:p3' }, 'failed', 1),
    'tester(codex) 失败，exit=1，pane=w2J:p3。请根据结果决定下一步。',
  );
});

test('leader worker finish notification includes handoff details', () => {
  assert.equal(
    formatLeaderWorkerFinish({
      member_id: 'worker_1',
      agent_role: 'worker',
      worker_role: 'tester',
      agent_kind: 'codex',
      pane_id: 'w2J:p3',
      finish_result: {
        changed: '验证 shutdown restore 修复',
        verified: 'focused、全量测试、check、build 都通过',
        blockers: 'none',
        recommended_next: 'reviewer 复核 HIGH 是否关闭',
        created_at: '2026-07-06T00:00:00.000Z',
      },
    }),
    'tester(codex) 已完成，pane=w2J:p3。\nchanged: 验证 shutdown restore 修复\nverified: focused、全量测试、check、build 都通过\nblockers: none\nrecommended_next: reviewer 复核 HIGH 是否关闭',
  );
});

test('team finish submits handoff details to the leader pane', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-finish-'));
  const token = join(dir, 'team.json');
  const calls = join(dir, 'calls.jsonl');
  const herdr = join(dir, 'herdr');
  writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nprintf '{}\\n'\n`);
  chmodSync(herdr, 0o755);
  writeTeamState(token, {
    mode: 'team',
    team_id: 'team_1',
    profile: 'engineering',
    source_cwd: '/repo',
    source_branch: 'main',
    base_commit: 'abc123',
    shared_workspace_id: 'workspace_1',
    shared_worktree_path: '/repo/worktree',
    branch: 'worktree/task',
    merge_token_path: join(dir, 'merge.json'),
    team_token_path: token,
    herdr_bin: herdr,
    layout: 'right',
    merge_mode: 'rebase',
    leader: {
      member_id: 'leader_1',
      team_id: 'team_1',
      agent_run_id: 'agent_leader',
      agent_name: 'wt-leader',
      agent_role: 'leader',
      agent_kind: 'opencode',
      workspace_id: 'workspace_1',
      worktree_path: '/repo/worktree',
      status: 'running',
      started_at: '2026-07-06T00:00:00.000Z',
      pane_id: 'leader:p1',
    },
    workers: [{
      member_id: 'worker_1',
      team_id: 'team_1',
      agent_run_id: 'agent_worker',
      agent_name: 'wt-tester',
      agent_role: 'worker',
      worker_role: 'tester',
      agent_kind: 'codex',
      workspace_id: 'workspace_1',
      worktree_path: '/repo/worktree',
      status: 'running',
      started_at: '2026-07-06T00:00:00.000Z',
      pane_id: 'worker:p2',
    }],
    active_worker_id: 'worker_1',
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
  });

  withCapturedStdout(() => runTeamFinish({
    token,
    worker: 'worker_1',
    changed: '验证 shutdown restore 修复',
    verified: 'focused、全量测试、check、build 都通过',
    blockers: 'none',
    recommendedNext: 'reviewer 复核 HIGH 是否关闭',
  }));

  const sentText = readFileSync(calls, 'utf8');
  assert.match(sentText, /pane send-text leader:p1/);
  assert.match(sentText, /changed: 验证 shutdown restore 修复/);
  assert.match(sentText, /verified: focused、全量测试、check、build 都通过/);
  assert.match(sentText, /blockers: none/);
  assert.match(sentText, /recommended_next: reviewer 复核 HIGH 是否关闭/);
});

function withCapturedStdout(fn) {
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return fn();
  } finally {
    process.stdout.write = originalWrite;
  }
}

test('leader worker checklist notification is structured and compact', () => {
  assert.equal(
    formatLeaderWorkerChecklist({
      member_id: 'worker_1',
      agent_role: 'worker',
      worker_role: 'implementer',
      agent_kind: 'codex',
      pane_id: 'w2J:p2',
      checklist: {
        items: [
          { text: 'inspect paths', done: true },
          { text: 'implement scoped change', done: false },
        ],
        current: 'editing component',
        updated_at: '2026-07-03T00:00:00.000Z',
      },
    }, '进展'),
    'implementer(codex) 进展:\n[x] inspect paths\n[ ] implement scoped change\ncurrent: editing component\npane=w2J:p2',
  );
});

test('team events brief is concise and sequence-addressable', () => {
  assert.equal(formatTeamEventsBrief([]), 'no new team events\n');
  assert.equal(
    formatTeamEventsBrief([
      { seq: 3, kind: 'worker_update', worker_id: 'worker_1', worker_role: 'implementer', agent_kind: 'codex', message: 'changed files; verified npm test', created_at: '2026-07-03T00:00:00.000Z' },
      { seq: 4, kind: 'worker_plan', worker_id: 'worker_1', worker_role: 'implementer', agent_kind: 'codex', message: '[ ] inspect\n[ ] implement', created_at: '2026-07-03T00:00:01.000Z' },
      { seq: 5, kind: 'worker_finished', worker_id: 'worker_1', worker_role: 'implementer', agent_kind: 'codex', message: 'changed files; verified npm test', created_at: '2026-07-03T00:00:02.000Z' },
    ]),
    '3 worker_update implementer(codex): changed files; verified npm test\n4 worker_plan implementer(codex): [ ] inspect\n  [ ] implement\n5 worker_finished implementer(codex): changed files; verified npm test\n',
  );
});

test('leader notification prefers direct pane delivery', () => {
  const calls = [];
  const result = notifyLeader(
    { herdr_bin: 'herdr', leader: { agent_name: 'generated-leader-name', pane_id: 'w2K:p1' } },
    'implementer(codex) 进展: inspected files',
    {
      sendToPane: (...args) => calls.push(['pane', ...args]),
      agentSend: (...args) => calls.push(['agent', ...args]),
    },
  );

  assert.deepEqual(calls, [['pane', 'herdr', 'w2K:p1', 'implementer(codex) 进展: inspected files']]);
  assert.deepEqual(result, { ok: true, method: 'pane', detail: 'w2K:p1' });
});

test('leader notification falls back to agent target without pane id', () => {
  const calls = [];
  const result = notifyLeader(
    { herdr_bin: 'herdr', leader: { agent_name: 'pi' } },
    'tester(codex) 已完成',
    {
      sendToPane: (...args) => calls.push(['pane', ...args]),
      agentSend: (...args) => calls.push(['agent', ...args]),
    },
  );

  assert.deepEqual(calls, [['agent', 'herdr', 'pi', 'tester(codex) 已完成']]);
  assert.deepEqual(result, { ok: true, method: 'agent', detail: 'pi' });
});

test('leader notification reports delivery failure', () => {
  const result = notifyLeader(
    { herdr_bin: 'herdr', leader: { agent_name: 'generated-leader-name', pane_id: 'w2K:p1' } },
    'implementer(codex) 已完成',
    {
      sendToPane: () => { throw new Error('pane not found'); },
      agentSend: () => {},
    },
  );

  assert.deepEqual(result, { ok: false, method: 'pane', detail: 'pane not found' });
});

test('last leader notification is exposed for status output', () => {
  const state = {
    events: [
      { seq: 1, kind: 'worker_done', worker_id: 'worker_1', worker_role: 'architect', agent_kind: 'pi', message: 'done', created_at: '2026-07-03T00:00:00.000Z' },
      { seq: 2, kind: 'leader_notify_failed', worker_id: 'worker_1', worker_role: 'architect', agent_kind: 'pi', message: 'pane: pane not found', created_at: '2026-07-03T00:00:01.000Z' },
    ],
  };

  assert.equal(getLastLeaderNotification(state).kind, 'leader_notify_failed');
  assert.equal(formatLastLeaderNotification(state), 'leader_notification: failed pane: pane not found');
});

test('team preflight reports dependency and git blockers', () => {
  const existing = new Set(['/repo/package.json', '/repo/pnpm-lock.yaml', '/repo/.git/worktrees/task/index.lock']);
  const report = buildTeamPreflightReport(
    '/repo',
    { strict: false },
    { existsSync: (path) => existing.has(path) },
    (_cwd, command) => command.join(' ') === 'git rev-parse --git-dir'
      ? { ok: true, stdout: '.git/worktrees/task\n', stderr: '' }
      : { ok: false, stdout: '', stderr: 'permission denied creating index.lock' },
    () => ({ ok: true, stdout: '', stderr: '' }),
  );

  assert.equal(report.ok, false);
  assert.match(formatTeamPreflightReport(report), /block git-index-lock: lock exists/);
  assert.match(formatTeamPreflightReport(report), /block git-index-writable: permission denied creating index.lock/);
  assert.match(formatTeamPreflightReport(report), /ok prepare-command: pnpm install --frozen-lockfile/);
  assert.match(formatTeamPreflightReport(report), /warn verify-command: no project verify_command configured/);
});

test('team preflight infers npm ci for package-lock projects', () => {
  const existing = new Set(['/repo/package.json', '/repo/package-lock.json']);
  const calls = [];
  const report = buildTeamPreflightReport(
    '/repo',
    { strict: false },
    { existsSync: (path) => existing.has(path) },
    (_cwd, command) => command.join(' ') === 'git rev-parse --git-dir'
      ? { ok: true, stdout: '/repo/.git\n', stderr: '' }
      : { ok: true, stdout: '', stderr: '' },
    (cwd, command) => {
      calls.push([cwd, command]);
      return { ok: true, stdout: 'installed', stderr: '' };
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [['/repo', 'npm ci']]);
  assert.match(formatTeamPreflightReport(report), /ok prepare-command: npm ci/);
});

test('team preflight skips inferred install when dependencies exist', () => {
  const existing = new Set(['/repo/package.json', '/repo/package-lock.json', '/repo/node_modules']);
  const calls = [];
  const report = buildTeamPreflightReport(
    '/repo',
    { strict: false },
    { existsSync: (path) => existing.has(path) },
    (_cwd, command) => command.join(' ') === 'git rev-parse --git-dir'
      ? { ok: true, stdout: '/repo/.git\n', stderr: '' }
      : { ok: true, stdout: '', stderr: '' },
    (cwd, command) => {
      calls.push([cwd, command]);
      return { ok: true, stdout: 'installed', stderr: '' };
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(calls, []);
  assert.match(formatTeamPreflightReport(report), /warn prepare-command: package.json found but no project prepare_command configured/);
});

test('team preflight keeps inferred prepare failures concise', () => {
  const existing = new Set(['/repo/package.json', '/repo/package-lock.json']);
  const report = buildTeamPreflightReport(
    '/repo',
    { strict: false },
    { existsSync: (path) => existing.has(path) },
    (_cwd, command) => command.join(' ') === 'git rev-parse --git-dir'
      ? { ok: true, stdout: '/repo/.git\n', stderr: '' }
      : { ok: true, stdout: '', stderr: '' },
    () => ({ ok: false, stdout: '', stderr: `line 1\n${'x'.repeat(500)}` }),
  );

  const output = formatTeamPreflightReport(report);
  assert.equal(report.ok, false);
  assert.match(output, /block prepare-command: line 1/);
  assert.ok(output.length < 420);
});

test('team preflight runs project prepare command when configured', () => {
  const calls = [];
  const report = buildTeamPreflightReport(
    '/repo',
    { strict: true, prepareCommand: 'make bootstrap', verifyCommand: 'make test' },
    { existsSync: () => false },
    (_cwd, command) => command.join(' ') === 'git rev-parse --git-dir'
      ? { ok: true, stdout: '/repo/.git\n', stderr: '' }
      : { ok: true, stdout: '', stderr: '' },
    (cwd, command) => {
      calls.push([cwd, command]);
      return { ok: true, stdout: 'ready', stderr: '' };
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(calls, [['/repo', 'make bootstrap']]);
  assert.match(formatTeamPreflightReport(report), /ok prepare-command: make bootstrap/);
  assert.match(formatTeamPreflightReport(report), /ok verify-command: make test/);
});

test('team preflight blocks when configured prepare command fails', () => {
  const report = buildTeamPreflightReport(
    '/repo',
    { strict: false, prepareCommand: 'make bootstrap' },
    { existsSync: () => false },
    (_cwd, command) => command.join(' ') === 'git rev-parse --git-dir'
      ? { ok: true, stdout: '/repo/.git\n', stderr: '' }
      : { ok: true, stdout: '', stderr: '' },
    () => ({ ok: false, stdout: '', stderr: 'missing toolchain' }),
  );

  assert.equal(report.ok, false);
  assert.match(formatTeamPreflightReport(report), /block prepare-command: missing toolchain/);
});
