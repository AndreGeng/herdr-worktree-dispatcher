import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';

import type { Command } from 'commander';

import { loadWorktreePreflightConfig, resolveLanguage, type WorktreePreflightConfig } from '../config/config.js';
import { buildAgentRunCommand } from '../herdr/agentRunner.js';
import { isWorktreeDirty } from '../git/git.js';
import { agentSend, closePane, findRootPaneId, getAgentPaneId, runInPane, sendToPane, splitPane } from '../herdr/client.js';
import { writeWorktreePromptFile, writeWorktreeRunScript } from '../prompt/addPrompt.js';
import { buildWorkerPrompt } from '../prompt/teamPrompt.js';
import { loadTeamProfile, resolveWorkerAgent } from '../team/profiles.js';
import { addRunningWorker, listTeamEvents, markWorkerDone, markWorkerFailed, readTeamState, recordLeaderNotification, recordWorkerChecklistUpdate, recordWorkerFinish, recordWorkerPlan, writeTeamState } from '../team/state.js';
import type { TeamEvent, TeamMember } from '../team/types.js';
import { createTraceIdentity, ensureTraceFile, writeLatestTraceIndex } from '../trace/paths.js';
import { inferAgentKind } from '../trace/parsers.js';
import { die } from '../utils/errors.js';
import { dispatchScriptPath } from '../utils/paths.js';
import { shellQuote } from '../utils/process.js';
import { slugify, trimTrailingWhitespace } from '../utils/text.js';

interface TeamTokenOptions {
  token?: string;
  brief?: boolean;
}

interface TeamSpawnOptions extends TeamTokenOptions {
  role?: string;
  agent?: string;
}

interface TeamDoneOptions extends TeamTokenOptions {
  worker?: string;
  exitCode?: string;
  logFile?: string;
  lastOutput?: string;
}

interface TeamMessageOptions extends TeamDoneOptions {}

interface TeamPlanOptions extends TeamDoneOptions {
  item?: string[];
  current?: string;
}

interface TeamUpdateOptions extends TeamDoneOptions {
  done?: string[];
  current?: string;
}

interface TeamEventsOptions extends TeamTokenOptions {
  since?: string;
}

interface TeamHandoffOptions extends TeamDoneOptions {
  changed?: string;
  verified?: string;
  blockers?: string;
  recommendedNext?: string;
}

export function registerTeam(program: Command): void {
  const team = program.command('team').description('Coordinate shared-worktree team workers');
  team
    .command('spawn')
    .description('Start a serial worker in the team shared worktree')
    .requiredOption('--token <path>', 'Team token path')
    .requiredOption('--role <role>', 'Worker role')
    .option('--agent <command>', 'Override worker agent command')
    .option('--brief', 'Print concise human-readable output')
    .argument('[task...]')
    .action((taskParts: string[], options: TeamSpawnOptions) => runTeamSpawn(taskParts, options));
  team
    .command('done', { hidden: true })
    .description('Internal wrapper command: mark a worker complete and release the serial worker lock')
    .requiredOption('--token <path>', 'Team token path')
    .requiredOption('--worker <id>', 'Worker id')
    .option('--exit-code <code>', 'Worker process exit code')
    .option('--log-file <path>', 'Worker log file path')
    .option('--last-output <text>', 'Truncated worker output tail')
    .option('--brief', 'Print concise human-readable output')
    .action((options: TeamDoneOptions) => runTeamDone(options));
  team
    .command('status')
    .description('Show team leader, worker, worktree, and lock status')
    .requiredOption('--token <path>', 'Team token path')
    .option('--brief', 'Print concise human-readable output')
    .action((options: TeamTokenOptions) => runTeamStatus(options));
  team
    .command('events')
    .description('Show recent structured team events for leader catch-up')
    .requiredOption('--token <path>', 'Team token path')
    .option('--since <seq>', 'Only show events after this sequence')
    .option('--brief', 'Print concise human-readable output')
    .action((options: TeamEventsOptions) => runTeamEvents(options));
  team
    .command('plan')
    .description('Record a worker execution checklist')
    .requiredOption('--token <path>', 'Team token path')
    .requiredOption('--worker <id>', 'Worker id')
    .requiredOption('--item <text>', 'Checklist item; repeat 3-10 times', collect, [])
    .option('--current <text>', 'Current activity')
    .option('--brief', 'Print concise human-readable output')
    .action((options: TeamPlanOptions) => runTeamPlan(options));
  team
    .command('update')
    .description('Update a worker execution checklist')
    .requiredOption('--token <path>', 'Team token path')
    .requiredOption('--worker <id>', 'Worker id')
    .option('--done <index>', 'Mark checklist item done; repeat as needed', collect, [])
    .option('--current <text>', 'Current activity')
    .option('--brief', 'Print concise human-readable output')
    .action((options: TeamUpdateOptions) => runTeamUpdate(options));
  team
    .command('finish')
    .description('Record worker final result and mark the worker done')
    .requiredOption('--token <path>', 'Team token path')
    .requiredOption('--worker <id>', 'Worker id')
    .requiredOption('--changed <text>', 'What changed or what was found')
    .requiredOption('--verified <text>', 'Checks or evidence')
    .requiredOption('--blockers <text>', 'Blockers, or none')
    .requiredOption('--recommended-next <text>', 'Recommended next role and reason')
    .option('--exit-code <code>', 'Worker process exit code')
    .option('--brief', 'Print concise human-readable output')
    .action((options: TeamHandoffOptions) => runTeamFinish(options));
  team
    .command('message')
    .description('Send a message to a team worker')
    .requiredOption('--token <path>', 'Team token path')
    .option('--worker <id>', 'Worker id; defaults to active worker')
    .option('--brief', 'Print concise human-readable output')
    .argument('[message...]')
    .action((messageParts: string[], options: TeamMessageOptions) => runTeamMessage(messageParts, options));
}

export function runTeamSpawn(taskParts: string[], options: TeamSpawnOptions): void {
  const tokenPath = requiredToken(options.token);
  const role = options.role || die('team spawn requires --role');
  const state = readTeamState(tokenPath);
  const preflightReport = buildTeamPreflightReport(state.shared_worktree_path, loadWorktreePreflightConfig({ projectConfigFile: state.project_config_file, profile: state.config_profile }));
  if (!preflightReport.ok) {
    process.stdout.write(formatTeamPreflightReport(preflightReport));
    process.exitCode = 1;
    return;
  }
  const profile = loadTeamProfile({ teamName: state.profile, herdrBin: state.herdr_bin, configFile: state.config_file, projectConfigFile: state.project_config_file, profile: state.config_profile });
  const roleConfig = profile.roles.find((item) => item.role === role);
  if (!roleConfig) die(`unknown team role: ${role}`);
  const agentCommand = resolveWorkerAgent(profile, role, options.agent);
  const taskText = readText(taskParts, 'worker task text is required');
  const workerId = `worker_${slugify(role)}_${Date.now().toString(36)}`;
  const agentName = `wt-${slugify(state.profile)}-${slugify(role)}`;
  const trace = createTraceIdentity({ agentKind: inferAgentKind(agentCommand), agentName, agentRole: 'worker', parentAgentRunId: state.leader.agent_run_id, workerRole: role, teamId: state.team_id, forceNewAgentRunId: true });
  ensureTraceFile(trace.trace_file);
  const promptPath = writeWorktreePromptFile(state.shared_worktree_path, `${state.profile}-${role}-${workerId}`);
  const language = state.language ?? resolveLanguage({ userConfigFile: state.config_file, projectConfigFile: state.project_config_file }, state.config_profile);
  const prompt = buildWorkerPrompt({ role: roleConfig, taskText, teamTokenPath: tokenPath, workerId, sharedWorktreePath: state.shared_worktree_path, language, mergeCommand: state.merge_command || `${shellQuote(dispatchScriptPath(import.meta.url))} merge --token ${shellQuote(state.merge_token_path)}` });
  writeFileSync(promptPath, prompt);
  const runner = buildAgentRunCommand({ agentCommand, cwd: state.shared_worktree_path, promptPath, traceEnv: traceEnv(trace, state.merge_token_path, role), shellExec: false });
  const logFile = `${state.shared_worktree_path}/.herdr-worktree-dispatcher/runs/${slugify(`${workerId}-output`)}.log`;
  const worker: TeamMember = {
    member_id: workerId,
    team_id: state.team_id,
    agent_run_id: trace.agent_run_id,
    parent_agent_run_id: trace.parent_agent_run_id,
    agent_name: agentName,
    agent_role: 'worker',
    worker_role: role,
    agent_kind: trace.agent_kind,
    workspace_id: state.shared_workspace_id,
    worktree_path: state.shared_worktree_path,
    status: 'running',
    started_at: trace.dispatch_started_at,
    prompt_file: promptPath,
    launch_mode: runner.needsPanePrompt ? 'interactive' : 'split',
    log_file: logFile,
  };
  let nextState = addRunningWorker(state, worker);
  writeLatestTraceIndex({ ...trace, token_path: state.merge_token_path, worktree_path: state.shared_worktree_path, branch: state.branch, source_cwd: state.source_cwd, worker_role: role });
  if (runner.needsPanePrompt) {
    writeTeamState(tokenPath, nextState);
    const agentResponse = startInteractiveWorker({ herdrBin: state.herdr_bin, agentCommand, agentName, workspaceId: state.shared_workspace_id, cwd: state.shared_worktree_path, leaderPaneId: state.leader.pane_id, split: state.layout, promptPath, prompt, traceEnv: traceEnv(trace, state.merge_token_path, role) });
    nextState = {
      ...nextState,
      workers: nextState.workers.map((item) => item.member_id === workerId ? { ...item, pane_id: agentResponse.paneId } : item),
    };
    writeTeamState(tokenPath, nextState);
  } else {
    const agentResponse = startSplitWorker({ herdrBin: state.herdr_bin, agentName, workspaceId: state.shared_workspace_id, cwd: state.shared_worktree_path, leaderPaneId: state.leader.pane_id, split: state.layout, command: runner.command, teamTokenPath: tokenPath, workerId, scriptPath: dispatchScriptPath(import.meta.url), workerLabel: `${role}(${trace.agent_kind})`, taskText, logFile });
    nextState = {
      ...nextState,
      workers: nextState.workers.map((item) => item.member_id === workerId ? { ...item, pane_id: agentResponse.paneId } : item),
    };
    writeTeamState(tokenPath, nextState);
  }
  const dispatched = nextState.workers.find((item) => item.member_id === workerId) || worker;
  const output = { status: 'worker_dispatched', team_id: state.team_id, worker_id: workerId, role, agent: agentCommand, agent_name: agentName, launch_mode: dispatched.launch_mode, tab_id: dispatched.tab_id, pane_id: dispatched.pane_id, pid: dispatched.pid, log_file: dispatched.log_file, prompt_file: promptPath, trace_file: trace.trace_file };
  if (options.brief) {
    process.stdout.write(formatTeamSpawnBrief(dispatched));
  } else {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

export function runTeamDone(options: TeamDoneOptions): void {
  const tokenPath = requiredToken(options.token);
  const workerId = options.worker || die('team done requires --worker');
  const state = readTeamState(tokenPath);
  const worker = state.workers.find((item) => item.member_id === workerId);
  const stateWithOutput = worker && (options.logFile || options.lastOutput)
    ? {
      ...state,
      workers: state.workers.map((item) => item.member_id === workerId ? { ...item, log_file: options.logFile || item.log_file, last_output: options.lastOutput || item.last_output } : item),
    }
    : state;
  const exitCode = parseExitCode(options.exitCode);
  const nextState = exitCode === undefined || exitCode === 0 ? markWorkerDone(stateWithOutput, workerId) : markWorkerFailed(stateWithOutput, workerId, exitCode);
  const status = exitCode && exitCode !== 0 ? 'failed' : 'done';
  const stateWithNotification = worker
    ? recordLeaderNotification(nextState, worker.member_id, notifyLeader(state, formatLeaderWorkerDone(worker, status, exitCode)))
    : nextState;
  writeTeamState(tokenPath, stateWithNotification);
  if (options.brief) process.stdout.write(`${workerId}: ${status}${exitCode !== undefined ? ` (exit ${exitCode})` : ''}\n`);
  else process.stdout.write(`${JSON.stringify({ status, team_id: state.team_id, worker_id: workerId, exit_code: exitCode })}\n`);
  closeWorkerPane(state.herdr_bin, worker?.pane_id);
}

export function runTeamPlan(options: TeamPlanOptions): void {
  const tokenPath = requiredToken(options.token);
  const workerId = options.worker || die('team plan requires --worker');
  const items = options.item || [];
  const state = readTeamState(tokenPath);
  const nextState = recordWorkerPlan(state, workerId, items, options.current);
  writeTeamState(tokenPath, nextState);
  const worker = nextState.workers.find((item) => item.member_id === workerId);
  if (worker) notifyLeader(state, formatLeaderWorkerChecklist(worker, '计划'));
  if (options.brief) process.stdout.write(`${workerId}: plan recorded\n`);
  else process.stdout.write(`${JSON.stringify({ status: 'plan_recorded', team_id: state.team_id, worker_id: workerId })}\n`);
}

export function runTeamUpdate(options: TeamUpdateOptions): void {
  const tokenPath = requiredToken(options.token);
  const workerId = options.worker || die('team update requires --worker');
  const doneIndexes = parseDoneIndexes(options.done || []);
  const state = readTeamState(tokenPath);
  const nextState = recordWorkerChecklistUpdate(state, workerId, doneIndexes, options.current);
  writeTeamState(tokenPath, nextState);
  const worker = nextState.workers.find((item) => item.member_id === workerId);
  if (worker) notifyLeader(state, formatLeaderWorkerChecklist(worker, '进展'));
  if (options.brief) process.stdout.write(`${workerId}: update recorded\n`);
  else process.stdout.write(`${JSON.stringify({ status: 'update_recorded', team_id: state.team_id, worker_id: workerId })}\n`);
}

export function runTeamFinish(options: TeamHandoffOptions): void {
  const tokenPath = requiredToken(options.token);
  const workerId = options.worker || die('team finish requires --worker');
  const state = readTeamState(tokenPath);
  const finished = recordWorkerFinish(state, workerId, {
    changed: requiredTextOption(options.changed, '--changed'),
    verified: requiredTextOption(options.verified, '--verified'),
    blockers: requiredTextOption(options.blockers, '--blockers'),
    recommended_next: requiredTextOption(options.recommendedNext, '--recommended-next'),
  });
  const exitCode = parseExitCode(options.exitCode);
  const nextState = exitCode === undefined || exitCode === 0 ? markWorkerDone(finished, workerId) : markWorkerFailed(finished, workerId, exitCode);
  const worker = nextState.workers.find((item) => item.member_id === workerId);
  const status = exitCode && exitCode !== 0 ? 'failed' : 'done';
  const stateWithNotification = worker
    ? recordLeaderNotification(nextState, worker.member_id, notifyLeader(state, formatLeaderWorkerFinish(worker, status, exitCode)))
    : nextState;
  writeTeamState(tokenPath, stateWithNotification);
  if (options.brief) process.stdout.write(`${workerId}: finish recorded\n`);
  else process.stdout.write(`${JSON.stringify({ status: 'finish_recorded', team_id: state.team_id, worker_id: workerId, exit_code: exitCode })}\n`);
  closeWorkerPane(state.herdr_bin, worker?.pane_id);
}

export function runTeamStatus(options: TeamTokenOptions): void {
  const state = readTeamState(requiredToken(options.token));
  if (options.brief) {
    const active = state.workers.find((worker) => worker.member_id === state.active_worker_id);
    const workers = state.workers.length ? state.workers.map(formatBriefWorker).join('\n') : 'no workers yet';
    const notification = formatLastLeaderNotification(state);
    process.stdout.write(`team ${state.team_id}\nactive: ${active ? `${formatWorkerLabel(active)} (${active.status})` : 'none'}\n${workers}${notification ? `\n${notification}` : ''}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    team_id: state.team_id,
    profile: state.profile,
    branch: state.branch,
    shared_worktree_path: state.shared_worktree_path,
    dirty: isWorktreeDirty(state.shared_worktree_path),
    leader: state.leader,
    active_worker_id: state.active_worker_id,
    workers: state.workers,
    last_leader_notification: getLastLeaderNotification(state),
    merge_token: state.merge_token_path,
  }, null, 2)}\n`);
}

export function runTeamEvents(options: TeamEventsOptions): void {
  const state = readTeamState(requiredToken(options.token));
  const sinceSeq = parseSinceSeq(options.since);
  const events = listTeamEvents(state, sinceSeq);
  if (options.brief) {
    process.stdout.write(formatTeamEventsBrief(events));
    return;
  }
  process.stdout.write(`${JSON.stringify({ status: 'ok', team_id: state.team_id, events }, null, 2)}\n`);
}

export function runTeamMessage(messageParts: string[], options: TeamMessageOptions): void {
  const state = readTeamState(requiredToken(options.token));
  const workerId = options.worker || state.active_worker_id || die('team message requires --worker when no active worker exists');
  const worker = state.workers.find((item) => item.member_id === workerId) || die(`worker not found: ${workerId}`);
  const message = readText(messageParts, 'message text is required');
  const paneId = getAgentPaneId(state.herdr_bin, worker.agent_name);
  if (paneId) {
    sendToPane(state.herdr_bin, paneId, message);
    const output = { status: 'sent', worker_id: workerId, agent: worker.agent_name, pane_id: paneId, submitted: true };
    if (options.brief) process.stdout.write(`sent to ${workerId}\n`);
    else process.stdout.write(`${JSON.stringify(output)}\n`);
  } else {
    agentSend(state.herdr_bin, worker.agent_name, message);
    const output = { status: 'sent', worker_id: workerId, agent: worker.agent_name, submitted: false };
    if (options.brief) process.stdout.write(`sent to ${workerId}\n`);
    else process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}

function startInteractiveWorker(input: { herdrBin: string; agentCommand: string; agentName: string; workspaceId: string; cwd: string; leaderPaneId?: string; split: 'right' | 'down'; promptPath: string; prompt: string; traceEnv: string }): { paneId?: string } {
  const runner = buildAgentRunCommand({ agentCommand: input.agentCommand, cwd: input.cwd, promptPath: input.promptPath, traceEnv: input.traceEnv, forceInteractive: true });
  const leaderPaneId = input.leaderPaneId || findRootPaneId(input.herdrBin, { workspaceId: input.workspaceId, cwd: input.cwd }) || die('could not resolve leader pane id for interactive worker');
  const pane = splitPane(input.herdrBin, { paneId: leaderPaneId, direction: input.split, cwd: input.cwd, focus: false });
  const runScript = writeWorktreeRunScript(input.cwd, `${input.agentName}-interactive`, runner.command);
  runInPane(input.herdrBin, pane.paneId, runScript);
  const delayMs = Number(process.env.HERDR_WORKTREE_AGENT_SEND_DELAY || '0.3') * 1000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  sendToPane(input.herdrBin, pane.paneId, input.prompt);
  return { paneId: pane.paneId };
}

function startSplitWorker(input: { herdrBin: string; agentName: string; workspaceId: string; cwd: string; leaderPaneId?: string; split: 'right' | 'down'; command: string; teamTokenPath: string; workerId: string; scriptPath: string; workerLabel: string; taskText: string; logFile: string }): { paneId?: string } {
  const doneCommand = `${shellQuote(input.scriptPath)} team done --token ${shellQuote(input.teamTokenPath)} --worker ${shellQuote(input.workerId)}`;
  const command = buildVisibleWorkerCommand({ command: input.command, doneCommand, workerLabel: input.workerLabel, worktreePath: input.cwd, taskText: input.taskText, logFile: input.logFile });
  const leaderPaneId = input.leaderPaneId || findRootPaneId(input.herdrBin, { workspaceId: input.workspaceId, cwd: input.cwd }) || die('could not resolve leader pane id for worker');
  const pane = splitPane(input.herdrBin, { paneId: leaderPaneId, direction: input.split, cwd: input.cwd, focus: false });
  const runScript = writeWorktreeRunScript(input.cwd, `${input.agentName}-worker`, command);
  runInPane(input.herdrBin, pane.paneId, runScript);
  return { paneId: pane.paneId };
}

function closeWorkerPane(herdrBin: string, paneId: string | undefined): boolean {
  if (!paneId) return false;
  try {
    closePane(herdrBin, paneId);
    return true;
  } catch {
    return false;
  }
}

export function formatBriefWorker(worker: TeamMember): string {
  return [
    `${formatWorkerLabel(worker)}: ${worker.status}`,
    worker.tab_id ? `tab: ${worker.tab_id}` : '',
    worker.pane_id ? `pane: ${worker.pane_id}` : '',
    worker.log_file ? `log: ${worker.log_file}` : '',
    worker.exit_code !== undefined ? `exit: ${worker.exit_code}` : '',
    worker.last_update ? `update:\n${indentBlock(worker.last_update)}` : '',
  ].filter(Boolean).join('\n');
}

function indentBlock(value: string): string {
  return value.split(/\r?\n/).map((line) => `  ${line}`).join('\n');
}

export function formatTeamSpawnBrief(worker: TeamMember): string {
  return [
    `dispatched ${formatWorkerLabel(worker)}`,
    `worker ${worker.member_id}`,
    worker.pane_id ? `pane ${worker.pane_id}` : '',
    `diagnostic team status --brief --token "$TEAM_TOKEN"`,
  ].filter(Boolean).join('\n') + '\n';
}

export function formatTeamEventsBrief(events: TeamEvent[]): string {
  if (events.length === 0) return 'no new team events\n';
  return events.map((event) => {
    const worker = event.worker_role && event.agent_kind ? `${event.worker_role}(${event.agent_kind})` : event.worker_id || 'team';
    return `${event.seq} ${event.kind} ${worker}: ${event.message.replace(/\n/g, '\n  ')}`;
  }).join('\n') + '\n';
}

export function getLastLeaderNotification(state: { events?: TeamEvent[] }): TeamEvent | undefined {
  return [...(state.events || [])].reverse().find((event) => event.kind === 'leader_notified' || event.kind === 'leader_notify_failed');
}

export function formatLastLeaderNotification(state: { events?: TeamEvent[] }): string {
  const event = getLastLeaderNotification(state);
  if (!event) return '';
  return `leader_notification: ${event.kind === 'leader_notified' ? 'ok' : 'failed'} ${event.message}`;
}

export function formatWorkerLabel(worker: Pick<TeamMember, 'worker_role' | 'agent_role' | 'agent_kind' | 'member_id'>): string {
  const role = worker.worker_role || worker.agent_role || worker.member_id;
  return `${role}(${worker.agent_kind})`;
}

export function formatLeaderWorkerChecklist(worker: Pick<TeamMember, 'worker_role' | 'agent_role' | 'agent_kind' | 'member_id' | 'pane_id' | 'checklist'>, label: string): string {
  const checklist = worker.checklist;
  if (!checklist) return `${formatWorkerLabel(worker)} ${label}: no checklist${worker.pane_id ? `。pane=${worker.pane_id}` : ''}`;
  const lines = checklist.items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`);
  if (checklist.current) lines.push(`current: ${checklist.current}`);
  return `${formatWorkerLabel(worker)} ${label}:\n${lines.join('\n')}${worker.pane_id ? `\npane=${worker.pane_id}` : ''}`;
}

export function formatLeaderWorkerDone(worker: Pick<TeamMember, 'worker_role' | 'agent_role' | 'agent_kind' | 'member_id' | 'pane_id'>, status: string, exitCode: number | undefined): string {
  const result = status === 'failed' ? `失败${exitCode !== undefined ? `，exit=${exitCode}` : ''}` : '已完成';
  return `${formatWorkerLabel(worker)} ${result}${worker.pane_id ? `，pane=${worker.pane_id}` : ''}。请根据结果决定下一步。`;
}

export function formatLeaderWorkerFinish(worker: Pick<TeamMember, 'worker_role' | 'agent_role' | 'agent_kind' | 'member_id' | 'pane_id' | 'finish_result'>, status = 'done', exitCode: number | undefined = undefined): string {
  const result = status === 'failed' ? `失败${exitCode !== undefined ? `，exit=${exitCode}` : ''}` : '已完成';
  const finish = worker.finish_result;
  const details = finish
    ? [
      `changed: ${finish.changed}`,
      `verified: ${finish.verified}`,
      `blockers: ${finish.blockers}`,
      `recommended_next: ${finish.recommended_next}`,
    ].join('\n')
    : 'finish details unavailable';
  return `${formatWorkerLabel(worker)} ${result}${worker.pane_id ? `，pane=${worker.pane_id}` : ''}。\n${details}`;
}

export interface TeamPreflightReport {
  ok: boolean;
  worktree_path: string;
  git_dir?: string;
  checks: Array<{ name: string; level: 'ok' | 'warn' | 'block'; detail: string }>;
}

export function buildTeamPreflightReport(worktreePath: string, preflightConfig: WorktreePreflightConfig = { strict: false }, fs = { existsSync }, runner = runCommandForPreflight, shellRunner = runShellCommandForPreflight): TeamPreflightReport {
  const checks: TeamPreflightReport['checks'] = [];
  const gitDirResult = runner(worktreePath, ['git', 'rev-parse', '--git-dir']);
  const rawGitDir = gitDirResult.ok ? gitDirResult.stdout.trim() : undefined;
  const gitDir = rawGitDir ? normalizeWorktreePath(worktreePath, rawGitDir) : undefined;
  checks.push({ name: 'git-dir', level: gitDirResult.ok && Boolean(gitDir) ? 'ok' : 'block', detail: gitDir || gitDirResult.stderr.trim() || 'missing git dir' });
  if (gitDir) {
    const lockPath = `${gitDir}/index.lock`;
    checks.push({ name: 'git-index-lock', level: !fs.existsSync(lockPath) ? 'ok' : 'block', detail: fs.existsSync(lockPath) ? `lock exists: ${lockPath}` : 'no index.lock' });
    const addDryRun = runner(worktreePath, ['git', 'add', '--dry-run', '.']);
    checks.push({ name: 'git-index-writable', level: addDryRun.ok ? 'ok' : 'block', detail: addDryRun.ok ? 'git add --dry-run succeeded' : addDryRun.stderr.trim() || addDryRun.stdout.trim() || 'git add --dry-run failed' });
  }
  const hasPackageJson = fs.existsSync(`${worktreePath}/package.json`);
  const prepareCommand = preflightConfig.prepareCommand || inferPrepareCommand(worktreePath, fs);
  if (prepareCommand) {
    const prepare = shellRunner(worktreePath, prepareCommand);
    checks.push({ name: 'prepare-command', level: prepare.ok ? 'ok' : 'block', detail: prepare.ok ? prepareCommand : summarizePreflightFailure(prepare.stderr || prepare.stdout, prepareCommand) });
  }
  else checks.push({ name: 'prepare-command', level: preflightConfig.strict ? 'block' : 'warn', detail: hasPackageJson ? 'package.json found but no project prepare_command configured' : 'no project prepare_command configured' });
  if (preflightConfig.verifyCommand) checks.push({ name: 'verify-command', level: 'ok', detail: preflightConfig.verifyCommand });
  else checks.push({ name: 'verify-command', level: preflightConfig.strict ? 'block' : 'warn', detail: 'no project verify_command configured' });
  return { ok: checks.every((check) => check.level !== 'block'), worktree_path: worktreePath, git_dir: gitDir, checks };
}

function normalizeWorktreePath(worktreePath: string, path: string): string {
  return isAbsolute(path) ? path : join(worktreePath, path);
}

function inferPrepareCommand(worktreePath: string, fs: { existsSync: (path: string) => boolean }): string | undefined {
  if (!fs.existsSync(`${worktreePath}/package.json`)) return undefined;
  if (fs.existsSync(`${worktreePath}/node_modules`)) return undefined;
  if (fs.existsSync(`${worktreePath}/pnpm-lock.yaml`)) return 'pnpm install --frozen-lockfile';
  if (fs.existsSync(`${worktreePath}/package-lock.json`)) return 'npm ci';
  if (fs.existsSync(`${worktreePath}/yarn.lock`)) return 'yarn install --frozen-lockfile';
  if (fs.existsSync(`${worktreePath}/bun.lockb`) || fs.existsSync(`${worktreePath}/bun.lock`)) return 'bun install --frozen-lockfile';
  return undefined;
}

function summarizePreflightFailure(output: string, command: string): string {
  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const detail = firstLine || `failed: ${command}`;
  return detail.length > 240 ? `${detail.slice(0, 237)}...` : detail;
}

export function formatTeamPreflightReport(report: TeamPreflightReport): string {
  const lines = [`preflight: ${report.ok ? 'ok' : 'blocked'}`, `worktree: ${report.worktree_path}`];
  for (const check of report.checks) lines.push(`${check.level} ${check.name}: ${check.detail}`);
  return `${lines.join('\n')}\n`;
}

export function notifyLeader(
  state: { herdr_bin: string; leader: { agent_name: string; pane_id?: string } },
  message: string,
  transport: { sendToPane: typeof sendToPane; agentSend: typeof agentSend } = { sendToPane, agentSend },
): { ok: boolean; method: string; detail: string } {
  try {
    if (state.leader.pane_id) {
      transport.sendToPane(state.herdr_bin, state.leader.pane_id, message);
      return { ok: true, method: 'pane', detail: state.leader.pane_id };
    }
    transport.agentSend(state.herdr_bin, state.leader.agent_name, message);
    return { ok: true, method: 'agent', detail: state.leader.agent_name };
  } catch (error) {
    return { ok: false, method: state.leader.pane_id ? 'pane' : 'agent', detail: error instanceof Error ? error.message : String(error) };
  }
}

export function buildVisibleWorkerCommand(input: { command: string; doneCommand: string; workerLabel?: string; worktreePath?: string; taskText?: string; logFile?: string }): string {
  const logFile = input.logFile || '';
  const tee = logFile ? ` | tee -a ${shellQuote(logFile)}` : '';
  const lastOutput = logFile ? `last_output=$(tail -n 20 ${shellQuote(logFile)} 2>/dev/null | sed ':a;N;$!ba;s/\\n/\\\\n/g')` : 'last_output=';
  const doneCommand = logFile ? `${input.doneCommand} --exit-code "$status" --log-file ${shellQuote(logFile)} --last-output "$last_output"` : `${input.doneCommand} --exit-code "$status"`;
  return [
    'set +e',
    logFile ? `: > ${shellQuote(logFile)}` : '',
    `printf '%s\n' ${shellQuote(`[herdr] worker ${input.workerLabel || 'worker'} started`)}${tee}`,
    input.worktreePath ? `printf '%s\n' ${shellQuote(`[herdr] worktree: ${input.worktreePath}`)}${tee}` : '',
    input.taskText ? `printf '%s\n' ${shellQuote(`[herdr] task: ${input.taskText}`)}${tee}` : '',
    `printf '%s\n' ${shellQuote('[herdr] --- agent output ---')}${tee}`,
    logFile ? `( ${input.command} </dev/null ) 2>&1 | tee -a ${shellQuote(logFile)}` : `${input.command} </dev/null`,
    'status=$?',
    `printf '%s\n' ${shellQuote('[herdr] --- worker result ---')}${tee}`,
    `printf '%s\n' "[herdr] exit_code=$status"${tee}`,
    logFile ? `printf '%s\n' ${shellQuote(`[herdr] log: ${logFile}`)}${tee}` : '',
    lastOutput,
    doneCommand,
    'exit "$status"',
  ].filter(Boolean).join('; ');
}

function parseExitCode(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) die(`invalid --exit-code: ${value}`);
  return parsed;
}

function parseSinceSeq(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) die(`invalid --since: ${value}`);
  return parsed;
}

function parseDoneIndexes(values: string[]): number[] {
  return values.map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) die(`invalid --done index: ${value}`);
    return parsed;
  });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function runCommandForPreflight(cwd: string, command: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command[0], command.slice(1), { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || result.error?.message || '' };
}

function runShellCommandForPreflight(cwd: string, command: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, { cwd, encoding: 'utf8', shell: true });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || result.error?.message || '' };
}

function traceEnv(trace: ReturnType<typeof createTraceIdentity>, tokenPath: string, workerRole: string): string {
  return [
    ['HERDR_TRACE_RUN_ID', trace.run_id],
    ['HERDR_TRACE_TEAM_ID', trace.team_id || ''],
    ['HERDR_TRACE_AGENT_RUN_ID', trace.agent_run_id],
    ['HERDR_TRACE_PARENT_AGENT_RUN_ID', trace.parent_agent_run_id || ''],
    ['HERDR_TRACE_AGENT_ROLE', trace.agent_role],
    ['HERDR_TRACE_AGENT_KIND', trace.agent_kind],
    ['HERDR_TRACE_AGENT_NAME', trace.agent_name],
    ['HERDR_TRACE_WORKER_ROLE', workerRole],
    ['HERDR_TRACE_FILE', trace.trace_file],
    ['HERDR_TRACE_TOKEN_PATH', tokenPath],
  ].map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

function requiredToken(value: string | undefined): string {
  return value || die('team command requires --token');
}

function readText(parts: string[], emptyMessage: string): string {
  let value = '';
  if (parts.length > 0) value = parts.join(' ');
  else if (!process.stdin.isTTY) value = readFileSync(0, 'utf8');
  else die(emptyMessage);
  value = trimTrailingWhitespace(value);
  if (!value) die('text is empty');
  return value;
}

function requiredTextOption(value: string | undefined, name: string): string {
  const text = trimTrailingWhitespace(value || '');
  if (!text) die(`team finish requires ${name}`);
  return text;
}
