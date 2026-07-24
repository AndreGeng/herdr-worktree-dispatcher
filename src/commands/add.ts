import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Command } from 'commander';

import { loadConfig, resolveConfigFiles } from '../config/config.js';
import { currentBranchOrCommit, gitDirForWorktree, repoRoot, resolveCommit } from '../git/git.js';
import { buildAgentRunCommand } from '../herdr/agentRunner.js';
import { createWorktree, findRootPaneId, sendToPane, runInPane } from '../herdr/client.js';
import { buildAddPrompt, writeWorktreePromptFile, writeWorktreeRunScript } from '../prompt/addPrompt.js';
import { buildLeaderPrompt } from '../prompt/teamPrompt.js';
import { createTeamId, teamStatePath, writeTeamState } from '../team/state.js';
import { loadTeamProfile, resolveTeamName } from '../team/profiles.js';
import { createTokenPath, tokenLogPath, writeToken } from '../token/token.js';
import { createTraceIdentity, ensureTraceFile, writeLatestTraceIndex } from '../trace/paths.js';
import { inferAgentKind } from '../trace/parsers.js';
import { die } from '../utils/errors.js';
import { dispatchScriptPath } from '../utils/paths.js';
import { firstCommandToken, requireCommand, shellQuote } from '../utils/process.js';
import { branchSuffix, labelFromTask, slugify, trimTrailingWhitespace } from '../utils/text.js';

export interface AddAsset {
  sourcePath: string;
  name?: string;
  image?: boolean;
}

export interface AddOptions {
  promptFile?: string;
  config?: string;
  profile?: string;
  branch?: string;
  name?: string;
  agent?: string;
  agentArg?: string[];
  layout?: string;
  base?: string;
  mergeMode?: string;
  merge?: boolean;
  smokeTest?: boolean;
  team?: string | boolean;
  leaderAgent?: string;
  assets?: AddAsset[];
  batchDir?: string;
  batchTaskId?: string;
}

export interface AddOutput {
  status: 'dispatched';
  branch: string;
  label: string;
  workspace_id: string;
  worktree_workspace_id: string;
  tab_id: string;
  worktree_path: string;
  agent_name: string;
  pane_id: string;
  run_script: string;
  layout: string;
  merge_mode: string;
  cleanup_token: string;
  cleanup_log_file: string;
  merge_command: string;
  source_branch: string;
  agent_args: string[];
  run_id: string;
  team_id?: string;
  agent_run_id: string;
  agent_role: string;
  agent_kind: string;
  trace_file: string;
}

export function registerAdd(program: Command): void {
  program
    .command('add')
    .description('Create a Herdr worktree and start an agent with a task prompt')
    .argument('[task...]')
    .option('-P, --prompt-file <path>', 'Read task prompt from file')
    .option('--config <path>', 'Config file path')
    .option('--profile <name>', 'Profile name from config file')
    .option('-b, --branch <name>', 'Use explicit branch name')
    .option('-n, --name <name>', 'Use explicit agent/workspace label')
    .option('-a, --agent <command>', 'Agent command to start')
    .option('--agent-arg <arg>', 'Extra argument appended to the agent command', collect, [])
    .option('--layout <preset>', 'Pane layout preset: right or down')
    .option('--base <ref>', 'Base ref for new worktree')
    .option('--merge-mode <mode>', 'Merge instruction mode: rebase or merge')
    .option('--merge', 'Finalize by integrating the child branch back')
    .option('--smoke-test', 'Verify dispatch plumbing without asking for code edits')
    .option('--team [name]', 'Start a team leader using the named team profile')
    .option('--leader-agent <command>', 'Agent command to start for the team leader')
    .action((taskParts: string[], options: AddOptions) => {
      runAdd(taskParts, options);
    });
}

export function runAdd(taskParts: string[], options: AddOptions, emitOutput = true): AddOutput | undefined {
  const normalized = normalizeTeamTask(taskParts, options);
  taskParts = normalized.taskParts;
  options = normalized.options;
  const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
  requireCommand('git');
  requireCommand(herdrBin);

  const sourceCwd = resolveSourceCwd();
  const configFiles = resolveConfigFiles({ herdrBin, configFile: options.config, profile: options.profile, sourceCwd });
  const config = loadConfig({ herdrBin, configFile: options.config, profile: options.profile, sourceCwd });
  if (options.agent) config.agentCommand = options.agent;
  if (options.agentArg?.length) config.agentArgs.push(...options.agentArg);
  if (options.layout) {
    if (options.layout !== 'right' && options.layout !== 'down') die(`invalid --layout value: ${options.layout} (expected right or down)`);
    config.layoutPreset = options.layout;
  }
  if (options.mergeMode) {
    if (options.mergeMode !== 'rebase' && options.mergeMode !== 'merge') die(`invalid --merge-mode value: ${options.mergeMode} (expected merge or rebase)`);
    config.mergeMode = options.mergeMode;
  }
  if (options.merge) config.mergeInstruction = true;
  if (options.team) {
    runTeamAdd(taskParts, options, herdrBin, config, configFiles);
    return;
  }

  const root = repoRoot(sourceCwd);
  const baseRef = options.base || 'HEAD';
  const baseCommit = resolveCommit(sourceCwd, baseRef);
  const sourceBranch = currentBranchOrCommit(sourceCwd, baseCommit);
  let taskText = readTaskText(taskParts, options.promptFile);
  if (options.smokeTest) {
    taskText = `Smoke test the Herdr worktree dispatcher plumbing. Do not edit files. Report the current working directory, the current git branch, and whether this prompt was received. Then continue to the final dispatcher merge instruction. Original note: ${taskText}`;
  }

  const label = options.name || labelFromTask(taskText);
  const branch = options.branch || `worktree/${slugify(label)}-${branchSuffix()}`;
  const parentWorkspaceId = process.env.HERDR_WORKSPACE_ID || process.env.HERDR_ACTIVE_WORKSPACE_ID || undefined;
  const worktree = createWorktree(herdrBin, { branch, baseCommit, label, parentWorkspaceId, sourceCwd });
  const codexGitMetadataDir = firstCommandToken(config.agentCommand) === 'codex'
    ? gitDirForWorktree(worktree.worktreePath)
    : undefined;
  const materializedAssets = materializeTaskAssets(worktree.worktreePath, options.assets || []);
  if (materializedAssets.length > 0) {
    taskText += `\n\nDispatcher-materialized task assets:\n${materializedAssets.map((asset) => `- ${asset.path}`).join('\n')}`;
    if (firstCommandToken(config.agentCommand) === 'codex') {
      for (const asset of materializedAssets.filter((item) => item.image)) {
        config.agentArgs.push('-i', asset.path);
      }
    }
  }
  const agentName = `wt-${slugify(label)}`;
  const trace = createTraceIdentity({
    agentKind: inferAgentKind(config.agentCommand),
    agentName,
  });
  ensureTraceFile(trace.trace_file);
  const promptPath = writeWorktreePromptFile(worktree.worktreePath, label);

  let cleanupToken = '';
  let cleanupLogFile = '';
  let mergeCommand = '';
  if (config.mergeInstruction) {
    cleanupToken = createTokenPath(label);
    cleanupLogFile = tokenLogPath(cleanupToken);
    mergeCommand = `${shellQuote(dispatchScriptPath(import.meta.url))} merge --token ${shellQuote(cleanupToken)}`;
    writeToken(cleanupToken, {
      mode: 'merge',
      herdr_bin: herdrBin,
      tab_id: '',
      worktree_workspace_id: worktree.workspaceId,
      repo_root: root,
      worktree_path: worktree.worktreePath,
      branch,
      source_cwd: sourceCwd,
      source_branch: sourceBranch,
      merge_mode: config.mergeMode,
      agent_name: agentName,
      prompt_file: promptPath,
      run_id: trace.run_id,
      team_id: trace.team_id,
      agent_run_id: trace.agent_run_id,
      parent_agent_run_id: trace.parent_agent_run_id,
      agent_role: trace.agent_role,
      agent_kind: trace.agent_kind,
      trace_file: trace.trace_file,
      dispatch_started_at: trace.dispatch_started_at,
      batch_dir: options.batchDir,
      batch_task_id: options.batchTaskId,
    });
  }
  writeLatestTraceIndex({
    ...trace,
    token_path: cleanupToken || undefined,
    worktree_path: worktree.worktreePath,
    branch,
    source_cwd: sourceCwd,
  });

  const prompt = buildAddPrompt({
    taskText,
    language: config.language,
    mergeInstruction: config.mergeInstruction,
    mergeMode: config.mergeMode,
    sourceCwd,
    mergeCommand,
    cleanupLogFile,
  });
  writeFileSync(promptPath, prompt);

  const traceEnv = [
    ['HERDR_TRACE_RUN_ID', trace.run_id],
    ['HERDR_TRACE_TEAM_ID', trace.team_id || ''],
    ['HERDR_TRACE_AGENT_RUN_ID', trace.agent_run_id],
    ['HERDR_TRACE_PARENT_AGENT_RUN_ID', trace.parent_agent_run_id || ''],
    ['HERDR_TRACE_AGENT_ROLE', trace.agent_role],
    ['HERDR_TRACE_AGENT_KIND', trace.agent_kind],
    ['HERDR_TRACE_AGENT_NAME', trace.agent_name],
    ['HERDR_TRACE_FILE', trace.trace_file],
    ['HERDR_TRACE_TOKEN_PATH', cleanupToken],
  ]
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ');
  const runner = buildAgentRunCommand({ agentCommand: config.agentCommand, agentArgs: config.agentArgs, cwd: worktree.worktreePath, promptPath, traceEnv, forceInteractive: true, codexSafeAutomation: true, codexWritableDirs: codexGitMetadataDir ? [codexGitMetadataDir] : [] });
  const paneId = worktree.paneId || findRootPaneId(herdrBin, { workspaceId: worktree.workspaceId, cwd: worktree.worktreePath, tabId: worktree.tabId }) || die('could not resolve root pane id for created worktree');
  const runScript = writeWorktreeRunScript(worktree.worktreePath, `${label}-agent`, runner.command);
  runInPane(herdrBin, paneId, runScript);

  if (runner.needsPanePrompt) {
    const delayMs = Number(process.env.HERDR_WORKTREE_AGENT_SEND_DELAY || '0.3') * 1000;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    sendToPane(herdrBin, paneId, prompt);
  }

  const output: AddOutput = {
    status: 'dispatched',
    branch,
    label,
    workspace_id: worktree.workspaceId,
    worktree_workspace_id: worktree.workspaceId,
    tab_id: worktree.tabId || '',
    worktree_path: worktree.worktreePath,
    agent_name: agentName,
    pane_id: paneId,
    run_script: runScript,
    layout: config.layoutPreset,
    merge_mode: config.mergeMode,
    cleanup_token: cleanupToken,
    cleanup_log_file: cleanupLogFile,
    merge_command: mergeCommand,
    source_branch: sourceBranch,
    agent_args: config.agentArgs,
    run_id: trace.run_id,
    team_id: trace.team_id,
    agent_run_id: trace.agent_run_id,
    agent_role: trace.agent_role,
    agent_kind: trace.agent_kind,
    trace_file: trace.trace_file,
  };
  if (emitOutput) process.stdout.write(`${JSON.stringify(output)}\n`);
  return output;
}

function runTeamAdd(taskParts: string[], options: AddOptions, herdrBin: string, config: ReturnType<typeof loadConfig>, configFiles: ReturnType<typeof resolveConfigFiles>): void {
  const sourceCwd = resolveSourceCwd();
  const root = repoRoot(sourceCwd);
  const baseRef = options.base || 'HEAD';
  const baseCommit = resolveCommit(sourceCwd, baseRef);
  const sourceBranch = currentBranchOrCommit(sourceCwd, baseCommit);
  const taskText = readTaskText(taskParts, options.promptFile);
  const teamName = resolveTeamName(options.team, herdrBin, options.config, sourceCwd);
  const profile = loadTeamProfile({ teamName, herdrBin, configFile: configFiles.userConfigFile, projectConfigFile: configFiles.projectConfigFile, profile: options.profile, leaderAgent: options.leaderAgent });
  requireCommand(firstCommandToken(profile.leaderAgent));
  const label = options.name || labelFromTask(taskText);
  const branch = options.branch || `worktree/${slugify(label)}-${branchSuffix()}`;
  const parentWorkspaceId = process.env.HERDR_WORKSPACE_ID || process.env.HERDR_ACTIVE_WORKSPACE_ID || undefined;
  const worktree = createWorktree(herdrBin, { branch, baseCommit, label, parentWorkspaceId, sourceCwd });
  const teamId = createTeamId(label);
  const teamToken = teamStatePath(teamId);
  const agentName = `wt-${slugify(label)}-leader`;
  const trace = createTraceIdentity({ agentKind: inferAgentKind(profile.leaderAgent), agentName, agentRole: 'leader', teamId, forceNewAgentRunId: true });
  ensureTraceFile(trace.trace_file);
  const promptPath = writeWorktreePromptFile(worktree.worktreePath, `${label}-leader`);
  const mergeToken = createTokenPath(`${label}-team`);
  const cleanupLogFile = tokenLogPath(mergeToken);
  const mergeCommand = `${shellQuote(dispatchScriptPath(import.meta.url))} merge --token ${shellQuote(mergeToken)}`;
  writeToken(mergeToken, {
    mode: 'merge',
    herdr_bin: herdrBin,
    tab_id: '',
    worktree_workspace_id: worktree.workspaceId,
    repo_root: root,
    worktree_path: worktree.worktreePath,
    branch,
    source_cwd: sourceCwd,
    source_branch: sourceBranch,
    merge_mode: config.mergeMode,
    agent_name: agentName,
    prompt_file: promptPath,
    run_id: trace.run_id,
    team_id: teamId,
    agent_run_id: trace.agent_run_id,
    parent_agent_run_id: trace.parent_agent_run_id,
    agent_role: trace.agent_role,
    agent_kind: trace.agent_kind,
    trace_file: trace.trace_file,
    dispatch_started_at: trace.dispatch_started_at,
  });
  writeLatestTraceIndex({ ...trace, token_path: mergeToken, worktree_path: worktree.worktreePath, branch, source_cwd: sourceCwd });
  const prompt = buildLeaderPrompt({ taskText, profile, language: config.language, teamTokenPath: teamToken, sharedWorktreePath: worktree.worktreePath, mergeCommand, cleanupLogFile });
  writeFileSync(promptPath, prompt);
  const state = {
    mode: 'team' as const,
    team_id: teamId,
    profile: profile.name,
    source_cwd: sourceCwd,
    source_branch: sourceBranch,
    base_commit: baseCommit,
    shared_workspace_id: worktree.workspaceId,
    shared_worktree_path: worktree.worktreePath,
    branch,
    merge_token_path: mergeToken,
    merge_command: mergeCommand,
    team_token_path: teamToken,
    herdr_bin: herdrBin,
    config_file: configFiles.userConfigFile,
    project_config_file: configFiles.projectConfigFile,
    config_profile: options.profile,
    language: config.language,
    layout: config.layoutPreset,
    merge_mode: config.mergeMode,
    leader: {
      member_id: `${teamId}-leader`,
      team_id: teamId,
      agent_run_id: trace.agent_run_id,
      agent_name: agentName,
      agent_role: 'leader' as const,
      agent_kind: trace.agent_kind,
      workspace_id: worktree.workspaceId,
      worktree_path: worktree.worktreePath,
      status: 'running' as const,
      started_at: trace.dispatch_started_at,
      prompt_file: promptPath,
      tab_id: worktree.tabId,
      pane_id: worktree.paneId,
    },
    workers: [],
    created_at: trace.dispatch_started_at,
    updated_at: trace.dispatch_started_at,
  };
  const paneId = startTeamAgent({ herdrBin, agentCommand: profile.leaderAgent, agentArgs: config.agentArgs, agentName, workspaceId: worktree.workspaceId, cwd: worktree.worktreePath, tabId: worktree.tabId, paneId: worktree.paneId, promptPath, prompt, traceEnv: traceEnvPairs(trace, mergeToken, undefined) });
  writeTeamState(teamToken, { ...state, leader: { ...state.leader, pane_id: paneId } });
  process.stdout.write(`${JSON.stringify({ status: 'team_dispatched', team_id: teamId, profile: profile.name, branch, label, workspace_id: worktree.workspaceId, worktree_path: worktree.worktreePath, leader_agent: profile.leaderAgent, leader_agent_name: agentName, pane_id: paneId, team_token: teamToken, merge_token: mergeToken, merge_command: mergeCommand, trace_file: trace.trace_file })}\n`);
}

function startTeamAgent(input: { herdrBin: string; agentCommand: string; agentArgs: string[]; agentName: string; workspaceId: string; cwd: string; tabId?: string; paneId?: string; promptPath: string; prompt: string; traceEnv: string }): string {
  const runner = buildAgentRunCommand({ agentCommand: input.agentCommand, agentArgs: input.agentArgs, cwd: input.cwd, promptPath: input.promptPath, traceEnv: input.traceEnv, forceInteractive: true });
  const paneId = input.paneId || findRootPaneId(input.herdrBin, { workspaceId: input.workspaceId, cwd: input.cwd, tabId: input.tabId }) || die('could not resolve root pane id for team leader');
  const runScript = writeWorktreeRunScript(input.cwd, `${input.agentName}-leader`, runner.command);
  runInPane(input.herdrBin, paneId, runScript);
  if (runner.needsPanePrompt) {
    const delayMs = Number(process.env.HERDR_WORKTREE_AGENT_SEND_DELAY || '0.3') * 1000;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    sendToPane(input.herdrBin, paneId, input.prompt);
  }
  return paneId;
}

function traceEnvPairs(trace: ReturnType<typeof createTraceIdentity>, tokenPath: string, workerRole: string | undefined): string {
  return [
    ['HERDR_TRACE_RUN_ID', trace.run_id],
    ['HERDR_TRACE_TEAM_ID', trace.team_id || ''],
    ['HERDR_TRACE_AGENT_RUN_ID', trace.agent_run_id],
    ['HERDR_TRACE_PARENT_AGENT_RUN_ID', trace.parent_agent_run_id || ''],
    ['HERDR_TRACE_AGENT_ROLE', trace.agent_role],
    ['HERDR_TRACE_AGENT_KIND', trace.agent_kind],
    ['HERDR_TRACE_AGENT_NAME', trace.agent_name],
    ['HERDR_TRACE_WORKER_ROLE', workerRole || ''],
    ['HERDR_TRACE_FILE', trace.trace_file],
    ['HERDR_TRACE_TOKEN_PATH', tokenPath],
  ].map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
}

function readTaskText(taskParts: string[], promptFile?: string): string {
  let taskText = '';
  if (promptFile) {
    taskText = readFileSync(promptFile, 'utf8');
  } else if (taskParts.length > 0) {
    taskText = taskParts.join(' ');
  } else if (!process.stdin.isTTY) {
    taskText = readFileSync(0, 'utf8');
  } else {
    die('task text is required');
  }
  taskText = trimTrailingWhitespace(taskText);
  if (!taskText) die('task text is empty');
  return taskText;
}

function normalizeTeamTask(taskParts: string[], options: AddOptions): { taskParts: string[]; options: AddOptions } {
  if (typeof options.team === 'string' && taskParts.length === 0 && /\s/.test(options.team)) {
    return { taskParts: [options.team], options: { ...options, team: true } };
  }
  return { taskParts, options };
}

function resolveSourceCwd(): string {
  if (process.env.HERDR_WORKSPACE_CWD) return process.env.HERDR_WORKSPACE_CWD;
  if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON);
      if (context.workspace_cwd) return context.workspace_cwd;
      if (context.focused_pane_cwd) return context.focused_pane_cwd;
    } catch {
      // Ignore malformed plugin context and fall back to PWD.
    }
  }
  return process.cwd();
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

export function materializeTaskAssets(worktreePath: string, assets: AddAsset[]): Array<{ path: string; image: boolean }> {
  if (assets.length === 0) return [];
  const outputDir = join(worktreePath, '.herdr-worktree-dispatcher', 'assets');
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const result: Array<{ path: string; image: boolean }> = [];
  const used = new Set<string>();
  for (const [index, asset] of assets.entries()) {
    const requested = basename(asset.name || asset.sourcePath) || `attachment-${index + 1}`;
    let name = requested;
    let duplicate = 2;
    while (used.has(name)) {
      const dot = requested.lastIndexOf('.');
      name = dot > 0
        ? `${requested.slice(0, dot)}-${duplicate}${requested.slice(dot)}`
        : `${requested}-${duplicate}`;
      duplicate += 1;
    }
    used.add(name);
    const destination = join(outputDir, name);
    copyFileSync(asset.sourcePath, destination);
    chmodSync(destination, 0o600);
    result.push({ path: destination, image: Boolean(asset.image) });
  }
  return result;
}
