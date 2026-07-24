import assert from 'node:assert/strict';
import test from 'node:test';

import { buildLeaderPrompt, buildWorkerPrompt } from '../dist/prompt/teamPrompt.js';

test('leader prompt includes roles, serial rule, and dispatcher commands', () => {
  const prompt = buildLeaderPrompt({
    taskText: 'Implement X',
    profile: { name: 'engineering', leaderAgent: 'pi', maxActiveWorkers: 1, defaultWorkerAgent: 'codex', workerAgents: {}, roles: [{ role: 'reviewer', name: 'Reviewer', description: 'Review diff', success: 'file evidence' }] },
    language: 'en-US',
    teamTokenPath: '/tmp/team.json',
    sharedWorktreePath: '/tmp/worktree',
    mergeCommand: 'herdr-worktree-dispatcher merge --token /tmp/merge.json',
    cleanupLogFile: '/tmp/merge.log',
  });
  assert.match(prompt, /reviewer: Reviewer - Review diff/);
  assert.match(prompt, /Roles are capabilities, not a fixed workflow/);
  assert.match(prompt, /Choose the next role based on the current task state and evidence/);
  assert.match(prompt, /do not directly implement, inspect, test, or document/);
  assert.match(prompt, /readable control room/);
  assert.match(prompt, /Use en-US by default/);
  assert.match(prompt, /generated human-readable file content/);
  assert.match(prompt, /include its runtime as role\(runtime\)/);
  assert.match(prompt, /implementer\(codex\)/);
  assert.match(prompt, /Advance the task only by dispatching workers/);
  assert.match(prompt, /Never run git status, git diff/);
  assert.match(prompt, /delegate those checks to reviewer, tester, or shipper workers/);
  assert.match(prompt, /do not block your pane on long waits/);
  assert.match(prompt, /separate non-focused split panes/);
  assert.match(prompt, /closes automatically when the worker finishes/);
  assert.match(prompt, /Use worker finish events and completion notifications as the primary coordination signal/);
  assert.match(prompt, /read structured events with team events instead of watching raw worker output/);
  assert.match(prompt, /Summarize worker finishes to the user in the configured language/);
  assert.match(prompt, /Worker plan\/update\/finish is recorded in team state/);
  assert.match(prompt, /only at meaningful transitions/);
  assert.doesNotMatch(prompt, /periodically run team status/);
  assert.match(prompt, /dispatch shipper as the final role/);
  assert.match(prompt, /only role that should commit project changes/);
  assert.match(prompt, /TEAM_TOKEN='\/tmp\/team\.json'/);
  assert.match(prompt, /team spawn --brief --token "\$TEAM_TOKEN" --role <role>/);
  assert.match(prompt, /team events --brief --token "\$TEAM_TOKEN"/);
  assert.match(prompt, /Diagnostic status check: herdr-worktree-dispatcher team status --brief --token "\$TEAM_TOKEN"/);
  assert.match(prompt, /Do not infer worker ids from pane ids/);
  assert.doesNotMatch(prompt, /team dashboard/);
  assert.doesNotMatch(prompt, /team watch/);
  assert.doesNotMatch(prompt, /Watch active worker: .*--worker <worker-id>/);
  assert.match(prompt, /Environment and git-write readiness are worker\/runtime concerns/);
  assert.doesNotMatch(prompt, /Environment preflight: herdr-worktree-dispatcher team preflight/);
  assert.doesNotMatch(prompt, /team done --brief/);
});

test('worker prompt includes role config and checklist commands', () => {
  const prompt = buildWorkerPrompt({
    role: { role: 'designer', name: 'UI Designer', description: 'Review UX', output: 'docs/reports/design.md', success: 'actionable findings' },
    taskText: 'Review the dashboard',
    teamTokenPath: '/tmp/team.json',
    workerId: 'worker_1',
    sharedWorktreePath: '/tmp/worktree',
    language: 'en-US',
  });
  assert.match(prompt, /Role id: designer/);
  assert.match(prompt, /Expected output: docs\/reports\/design\.md/);
  assert.match(prompt, /Non-interactive workers are finalized automatically/);
  assert.match(prompt, /team plan --brief --token \/tmp\/team\.json --worker worker_1/);
  assert.match(prompt, /Language: use en-US for natural-language summaries/);
  assert.match(prompt, /generated human-readable file content/);
  assert.match(prompt, /human-readable values passed to team plan\/update\/finish/);
  assert.match(prompt, /Keep commands, paths, ids, role names, option names, exit codes, and original error text unchanged/);
  assert.match(prompt, /publish a 3-10 item execution checklist/);
  assert.match(prompt, /Prefer 5-8 checklist items/);
  assert.match(prompt, /Do not exceed 10 items/);
  assert.match(prompt, /team update --brief --token \/tmp\/team\.json --worker worker_1 --done 1/);
  assert.match(prompt, /Before finishing, record one structured finish command/);
  assert.match(prompt, /team finish --brief --token \/tmp\/team\.json --worker worker_1 --changed/);
  assert.match(prompt, /--recommended-next "<role and reason>"/);
  assert.doesNotMatch(prompt, /team progress/);
  assert.doesNotMatch(prompt, /team handoff/);
  assert.doesNotMatch(prompt, /team done --token/);
  assert.doesNotMatch(prompt, /team preflight/);
});

test('shipper prompt owns commit and merge', () => {
  const prompt = buildWorkerPrompt({
    role: { role: 'shipper', name: 'Shipper', description: 'Commit and merge' },
    taskText: 'Ship the completed work',
    language: 'zh-CN',
    teamTokenPath: '/tmp/team.json',
    workerId: 'worker_shipper',
    sharedWorktreePath: '/tmp/worktree',
    mergeCommand: 'herdr-worktree-dispatcher merge --token /tmp/merge.json',
  });

  assert.match(prompt, /only worker role allowed to commit project changes/);
  assert.doesNotMatch(prompt, /preflight command/);
  assert.doesNotMatch(prompt, /team preflight/);
  assert.match(prompt, /If there are no project changes to commit, do not create an empty commit/);
  assert.match(prompt, /herdr-worktree-dispatcher merge --token \/tmp\/merge\.json/);
});
