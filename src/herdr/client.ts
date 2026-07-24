import { die } from '../utils/errors.js';
import { run } from '../utils/process.js';

export interface WorktreeCreateResult {
  workspaceId: string;
  worktreePath: string;
  tabId?: string;
  paneId?: string;
}

export interface AgentStartResult {
  raw: unknown;
  paneId?: string;
}

export interface TabCreateResult {
  raw: unknown;
  tabId: string;
  paneId?: string;
}

export interface PaneSplitResult {
  raw: unknown;
  paneId: string;
}

export function createWorktree(
  herdrBin: string,
  input: { branch: string; baseCommit: string; label: string; parentWorkspaceId?: string; sourceCwd: string },
): WorktreeCreateResult {
  const args = ['worktree', 'create', '--branch', input.branch, '--base', input.baseCommit, '--label', input.label, '--no-focus'];
  if (input.parentWorkspaceId) args.push('--workspace', input.parentWorkspaceId);
  else args.push('--cwd', input.sourceCwd);
  args.push('--json');
  const response = parseJson(run(herdrBin, args), 'worktree create');
  if (response?.result?.type !== 'worktree_created') die(`worktree create failed: ${JSON.stringify(response)}`);
  const workspaceId = response.result?.workspace?.workspace_id;
  const worktreePath = response.result?.worktree?.path;
  const tabId = findFirstString(response, ['result.tab_id', 'result.tab.tab_id', 'result.tab.id', 'result.workspace.tab_id', 'result.workspace.tab.tab_id']);
  const paneId = findFirstString(response, ['result.root_pane.pane_id', 'result.root_pane.id', 'result.pane_id', 'result.pane.pane_id', 'result.pane.id']);
  if (!workspaceId) die('worktree create response did not include workspace id');
  if (!worktreePath) die('worktree create response did not include worktree path');
  return { workspaceId, worktreePath, tabId, paneId };
}

export function startAgent(
  herdrBin: string,
  input: { agentName: string; workspaceId: string; cwd: string; split?: string; command: string; tabId?: string },
): AgentStartResult {
  const args = buildAgentStartArgs(input);
  const raw = parseJson(run(herdrBin, args), 'agent start');
  return { raw, paneId: findFirstString(raw, ['result.pane_id', 'result.pane.pane_id', 'result.pane.id', 'pane_id', 'pane.pane_id', 'pane.id']) };
}

export function buildAgentStartArgs(input: { agentName: string; workspaceId: string; cwd: string; split?: string; command: string; tabId?: string }): string[] {
  const args = ['agent', 'start', input.agentName, '--workspace', input.workspaceId];
  if (input.tabId) args.push('--tab', input.tabId);
  args.push('--cwd', input.cwd);
  if (input.split) args.push('--split', input.split);
  args.push('--no-focus', '--', 'sh', '-lc', input.command);
  return args;
}

export function createTab(
  herdrBin: string,
  input: { workspaceId: string; cwd: string; label: string; focus?: boolean },
): TabCreateResult {
  const args = ['tab', 'create', '--workspace', input.workspaceId, '--cwd', input.cwd, '--label', input.label, input.focus ? '--focus' : '--no-focus'];
  const raw = parseJson(run(herdrBin, args), 'tab create');
  const tabId = findFirstString(raw, ['result.tab_id', 'result.tab.tab_id', 'result.tab.id', 'tab_id', 'tab.tab_id', 'tab.id']);
  const paneId = findFirstString(raw, ['result.root_pane.pane_id', 'result.root_pane.id', 'result.pane_id', 'result.pane.pane_id', 'pane_id', 'pane.pane_id']);
  if (!tabId) die(`tab create response did not include tab id: ${JSON.stringify(raw)}`);
  return { raw, tabId, paneId };
}

export function runInPane(herdrBin: string, paneId: string, command: string): void {
  run(herdrBin, buildPaneRunArgs(paneId, command));
}

export function splitPane(
  herdrBin: string,
  input: { paneId: string; direction: 'right' | 'down'; cwd: string; focus?: boolean },
): PaneSplitResult {
  const raw = parseJson(run(herdrBin, buildPaneSplitArgs(input)), 'pane split');
  const paneId = findFirstString(raw, ['result.pane_id', 'result.pane.pane_id', 'result.pane.id', 'pane_id', 'pane.pane_id']);
  if (!paneId) die(`pane split response did not include pane id: ${JSON.stringify(raw)}`);
  return { raw, paneId };
}

export function buildPaneSplitArgs(input: { paneId: string; direction: 'right' | 'down'; cwd: string; focus?: boolean }): string[] {
  return ['pane', 'split', input.paneId, '--direction', input.direction, '--cwd', input.cwd, input.focus ? '--focus' : '--no-focus'];
}

export function closePane(herdrBin: string, paneId: string): void {
  run(herdrBin, buildPaneCloseArgs(paneId));
}

export function buildPaneCloseArgs(paneId: string): string[] {
  return ['pane', 'close', paneId];
}

export function buildPaneRunArgs(paneId: string, command: string): string[] {
  return ['pane', 'run', paneId, command];
}

export function findRootPaneId(herdrBin: string, input: { workspaceId: string; cwd: string; tabId?: string }): string | undefined {
  const raw = parseJson(run(herdrBin, ['pane', 'list', '--workspace', input.workspaceId]), 'pane list');
  const panes = raw?.result?.panes;
  if (!Array.isArray(panes)) return undefined;
  const candidates = panes.filter((pane) => {
    if (input.tabId && pane?.tab_id !== input.tabId) return false;
    return pane?.cwd === input.cwd || pane?.foreground_cwd === input.cwd;
  });
  const root = candidates.find((pane) => !pane?.agent && pane?.agent_status === 'unknown') || candidates.find((pane) => !pane?.agent) || candidates[0];
  return typeof root?.pane_id === 'string' ? root.pane_id : undefined;
}

export function findAgentTarget(herdrBin: string, workspaceId: string, cwd: string): string | undefined {
  const raw = parseJson(run(herdrBin, ['agent', 'list']), 'agent list');
  const agents = raw?.result?.agents;
  if (!Array.isArray(agents)) return undefined;
  for (const agent of agents) {
    if (agent?.workspace_id === workspaceId && (agent?.cwd === cwd || agent?.foreground_cwd === cwd)) {
      return agent.name || agent.agent || agent.pane_id;
    }
  }
  return undefined;
}

export function findAgentPaneId(herdrBin: string, workspaceId: string, cwd: string): string | undefined {
  const raw = parseJson(run(herdrBin, ['agent', 'list']), 'agent list');
  const agents = raw?.result?.agents;
  if (!Array.isArray(agents)) return undefined;
  for (const agent of agents) {
    if (agent?.workspace_id === workspaceId && (agent?.cwd === cwd || agent?.foreground_cwd === cwd)) {
      return agent.pane_id;
    }
  }
  return undefined;
}

export function getAgentPaneId(herdrBin: string, target: string): string | undefined {
  try {
    const raw = parseJson(run(herdrBin, ['agent', 'get', target]), 'agent get');
    return findFirstString(raw, ['result.agent.pane_id', 'result.pane_id', 'agent.pane_id', 'pane_id']);
  } catch {
    return undefined;
  }
}

export function sendToPane(herdrBin: string, paneId: string, text: string): void {
  run(herdrBin, ['pane', 'send-text', paneId, text]);
  run(herdrBin, ['pane', 'send-keys', paneId, 'Enter']);
}

export function agentSend(herdrBin: string, target: string, text: string): void {
  run(herdrBin, ['agent', 'send', target, text]);
}

export function removeWorktree(herdrBin: string, workspaceId: string): void {
  run(herdrBin, ['worktree', 'remove', '--workspace', workspaceId]);
}

function parseJson(output: string, label: string): any {
  try {
    return JSON.parse(output);
  } catch {
    die(`${label} did not return valid JSON: ${output}`);
  }
}

function findFirstString(value: any, paths: string[]): string | undefined {
  for (const path of paths) {
    let current = value;
    for (const part of path.split('.')) current = current?.[part];
    if (typeof current === 'string' && current) return current;
  }
  return undefined;
}
