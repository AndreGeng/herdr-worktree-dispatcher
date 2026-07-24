import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentRunCommand } from '../dist/herdr/agentRunner.js';

const base = {
  cwd: '/repo/worktree',
  promptPath: '/repo/worktree/.herdr-worktree-dispatcher/PROMPT-task.md',
  traceEnv: 'HERDR_TRACE_RUN_ID=run_1',
};

test('opencode uses a prompt-file runner', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'opencode' });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec opencode run --format default --dangerously-skip-permissions \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('codex uses non-interactive exec mode', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'codex' });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec codex exec --dangerously-bypass-approvals-and-sandbox --color always \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('pi uses non-interactive json mode', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'pi' });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec pi -p --mode json \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('claude uses non-interactive print mode', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'claude' });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec claude -p \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\" --output-format text --no-session-persistence --dangerously-skip-permissions");
});

test('unknown runtimes keep interactive pane injection', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'custom-agent', agentArgs: ['--flag'] });

  assert.equal(result.needsPanePrompt, true);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec custom-agent '--flag'");
});

test('forceInteractive codex passes the initial prompt to the TUI at startup', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'codex', forceInteractive: true });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec codex \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('non-team interactive codex uses safe unattended defaults', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: 'codex',
    forceInteractive: true,
    codexSafeAutomation: true,
    codexWritableDirs: ['/source/repo/.git'],
  });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec codex '-a' 'never' '-s' 'workspace-write' '--dangerously-bypass-hook-trust' '--add-dir' '/source/repo/.git' \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('non-team interactive codex respects explicit permissions and keeps extra directories', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: 'codex -a on-request',
    agentArgs: ['--sandbox', 'read-only', '--dangerously-bypass-hook-trust', '--add-dir', '/repo/shared'],
    forceInteractive: true,
    codexSafeAutomation: true,
    codexWritableDirs: ['/source/repo/.git'],
  });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec codex -a on-request '--sandbox' 'read-only' '--dangerously-bypass-hook-trust' '--add-dir' '/repo/shared' \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('non-team interactive codex adds Git metadata for quoted workspace-write mode', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: "codex --sandbox 'workspace-write'",
    forceInteractive: true,
    codexSafeAutomation: true,
    codexWritableDirs: ['/source/repo/.git'],
  });

  assert.match(result.command, /'--add-dir' '\/source\/repo\/\.git'/);
});

test('non-team interactive codex honors the final sandbox override', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: 'codex -c \'sandbox_mode="workspace-write"\'',
    agentArgs: ['--sandbox', 'read-only'],
    forceInteractive: true,
    codexSafeAutomation: true,
    codexWritableDirs: ['/source/repo/.git'],
  });

  assert.doesNotMatch(result.command, /source\/repo\/\.git/);
});

test('non-team interactive codex respects short equals read-only mode', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: 'codex -s=read-only',
    forceInteractive: true,
    codexSafeAutomation: true,
    codexWritableDirs: ['/source/repo/.git'],
  });

  assert.doesNotMatch(result.command, /workspace-write|source\/repo\/\.git/);
});

test('non-team interactive codex does not mix sandbox defaults with an explicit full bypass', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: 'codex',
    agentArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    forceInteractive: true,
    codexSafeAutomation: true,
    codexWritableDirs: ['/source/repo/.git'],
  });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec codex '--dangerously-bypass-hook-trust' '--dangerously-bypass-approvals-and-sandbox' \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('non-team interactive codex respects approval and sandbox config overrides', () => {
  const result = buildAgentRunCommand({
    ...base,
    agentCommand: 'codex',
    agentArgs: ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="read-only"'],
    forceInteractive: true,
    codexSafeAutomation: true,
  });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec codex '--dangerously-bypass-hook-trust' '-c' 'approval_policy=\"on-request\"' '-c' 'sandbox_mode=\"read-only\"' \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('forceInteractive pi uses pane prompt injection instead of json mode', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'pi', forceInteractive: true });

  assert.equal(result.needsPanePrompt, true);
  assert.equal(result.command, 'HERDR_TRACE_RUN_ID=run_1 exec pi');
});

test('forceInteractive opencode uses tui prompt option', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'opencode', forceInteractive: true });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 exec opencode --prompt \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});

test('background mode can omit shell exec for wrapper cleanup', () => {
  const result = buildAgentRunCommand({ ...base, agentCommand: 'codex', shellExec: false });

  assert.equal(result.needsPanePrompt, false);
  assert.equal(result.command, "HERDR_TRACE_RUN_ID=run_1 codex exec --dangerously-bypass-approvals-and-sandbox --color always \"$(cat '.herdr-worktree-dispatcher/PROMPT-task.md')\"");
});
