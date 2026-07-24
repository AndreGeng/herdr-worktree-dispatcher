import { existsSync, readFileSync } from 'node:fs';

import { getConfigSection, getMergedConfigSection, resolveConfigFiles } from '../config/config.js';
import { die } from '../utils/errors.js';
import { commandExists, firstCommandToken } from '../utils/process.js';
import type { TeamProfile, TeamRole } from './types.js';

const BUILTIN_ENGINEERING: TeamProfile = {
  name: 'engineering',
  leaderAgent: 'opencode',
  defaultWorkerAgent: 'pi',
  workerAgentPool: ['claude', 'codex'],
  maxActiveWorkers: 1,
  workerAgents: {},
  roles: [
    {
      role: 'investigator',
      name: 'Investigator',
      description: 'Investigate unclear problems, reproduce failures, trace root causes, and recommend the next role before implementation.',
      success: 'root cause, evidence, blockers, and recommended next role are reported clearly',
    },
    {
      role: 'architect',
      name: 'Architect',
      description: 'Design technical approach, module boundaries, data flow, APIs, and migration strategy before broad or risky changes.',
      success: 'technical design is scoped, testable, and explicit about tradeoffs and risks',
    },
    {
      role: 'implementer',
      name: 'Implementer',
      description: 'Implement scoped code changes in the shared worktree.',
      success: 'changes are minimal, verified, and summarized for the leader',
    },
    {
      role: 'reviewer',
      name: 'Code Reviewer',
      description: 'Review the current diff for correctness, security, maintainability, and missing tests.',
      success: 'findings are severity-ranked with file and line evidence',
    },
    {
      role: 'tester',
      name: 'Tester',
      description: 'Run focused verification and diagnose failures in the shared worktree.',
      success: 'test results and failure causes are reported clearly',
    },
    {
      role: 'docs',
      name: 'Documentation Writer',
      description: 'Update user-facing or maintainer documentation for the completed work.',
      success: 'documentation matches the shipped behavior',
    },
    {
      role: 'shipper',
      name: 'Shipper',
      description: 'Own final verification, commit project changes, and run the dispatcher merge command.',
      success: 'owned changes are committed and integrated, or a clear no-commit reason is reported',
    },
  ],
};

export function resolveTeamName(explicit: string | boolean | undefined, herdrBin: string, configFile?: string, sourceCwd?: string): string {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const files = resolveConfigFiles({ herdrBin, configFile, sourceCwd });
  const section = getMergedConfigSection(files, 'default');
  return section.team || 'engineering';
}

export function loadTeamProfile(input: { teamName: string; herdrBin: string; configFile?: string; projectConfigFile?: string; profile?: string; leaderAgent?: string }): TeamProfile {
  const files = resolveConfigFiles({ herdrBin: input.herdrBin, configFile: input.configFile });
  if (input.projectConfigFile && !input.configFile) files.projectConfigFile = input.projectConfigFile;
  const defaultSection = getMergedConfigSection(files, 'default');
  const profileSection = input.profile ? getMergedConfigSection(files, `profile.${input.profile}`) : {};
  const teamSection = getMergedConfigSection(files, `team.${input.teamName}`);
  const builtin = input.teamName === 'engineering' ? BUILTIN_ENGINEERING : emptyProfile(input.teamName);
  const roleSections = getTeamRoleSections(files, input.teamName);
  const finalRoles = parseList(teamSection.roles) || [...new Set([...builtin.roles.map((role) => role.role), ...roleSections.keys()])];
  const disabled = new Set(parseList(teamSection.disabled_roles) || []);
  const workerAgents = { ...builtin.workerAgents, ...parseWorkers(teamSection.workers) };
  const roles = finalRoles
    .filter((role) => !disabled.has(role))
    .map((role) => mergeRole(builtin.roles.find((item) => item.role === role), role, roleSections.get(role)));
  if (roles.length === 0) die(`team profile has no roles: ${input.teamName}`);
  return {
    name: input.teamName,
    leaderAgent: input.leaderAgent || teamSection.leader_agent || profileSection.agent || defaultSection.agent || builtin.leaderAgent,
    defaultWorkerAgent: teamSection.worker_agent || builtin.defaultWorkerAgent,
    workerAgentPool: parseList(teamSection.worker_agent_pool) || builtin.workerAgentPool,
    maxActiveWorkers: parsePositiveInt(teamSection.max_active_workers) || builtin.maxActiveWorkers,
    workerAgents,
    roles,
  };
}

export function resolveWorkerAgent(profile: TeamProfile, role: string, explicitAgent?: string, isInstalled: (command: string) => boolean = commandExists): string {
  const roleConfig = profile.roles.find((item) => item.role === role);
  if (!roleConfig) die(`unknown team role: ${role}`);
  const configuredAgent = explicitAgent || roleConfig.agent || profile.workerAgents[role];
  if (configuredAgent) {
    if (!isInstalled(firstCommandToken(configuredAgent))) die(`worker runtime is not installed for role ${role}: ${configuredAgent}`);
    return configuredAgent;
  }
  const candidates = [...new Set([...(profile.workerAgentPool || []), profile.defaultWorkerAgent].filter((agent): agent is string => Boolean(agent)))];
  const installed = candidates.filter((agent) => isInstalled(firstCommandToken(agent)));
  const agent = randomAgent(installed);
  if (!agent || agent === 'inherit-leader') die(`no installed worker runtime available for role: ${role} (tried: ${candidates.join(', ') || 'none'})`);
  return agent;
}

function emptyProfile(name: string): TeamProfile {
  return { name, leaderAgent: 'opencode', defaultWorkerAgent: 'pi', workerAgentPool: ['claude', 'codex'], maxActiveWorkers: 1, workerAgents: {}, roles: [] };
}

function randomAgent(pool: string[] | undefined): string | undefined {
  if (!pool?.length) return undefined;
  return pool[Math.floor(Math.random() * pool.length)];
}

function mergeRole(builtin: TeamRole | undefined, role: string, override: Record<string, string> | undefined): TeamRole {
  const merged: TeamRole = { role, name: role, description: `Run the ${role} role for this team task.`, ...builtin };
  if (!override) return merged;
  for (const [key, value] of Object.entries(override)) {
    if (key === 'tools') merged.tools = parseList(value) || [];
    else if (key in merged || ['agent', 'prompt', 'prompt_file', 'output', 'success', 'emoji', 'color', 'vibe', 'handoff', 'name', 'description'].includes(key)) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    } else {
      die(`unknown role config key for ${role}: ${key}`);
    }
  }
  if (merged.prompt_file) merged.prompt = readPromptFile(merged.prompt_file);
  return merged;
}

function getTeamRoleSections(files: { userConfigFile?: string; projectConfigFile?: string }, teamName: string): Map<string, Record<string, string>> {
  const roles = new Map<string, Record<string, string>>();
  for (const configFile of [files.userConfigFile, files.projectConfigFile].filter((file): file is string => Boolean(file))) {
    const contents = readFileSync(configFile, 'utf8');
    for (const match of contents.matchAll(/^\s*\[team\.([^\].]+)\.role\.([^\]]+)\]\s*$/gm)) {
      if (match[1] === teamName) roles.set(match[2], { ...(roles.get(match[2]) || {}), ...getConfigSection(configFile, `team.${teamName}.role.${match[2]}`) });
    }
  }
  return roles;
}

function parseWorkers(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of parseList(value) || []) {
    const [role, agent] = item.split(':').map((part) => part.trim());
    if (!role || !agent) die(`invalid workers entry: ${item}`);
    out[role] = agent;
  }
  return out;
}

function parseList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) die(`invalid max_active_workers: ${value}`);
  if (parsed !== 1) die('MVP only supports max_active_workers = 1');
  return parsed;
}

function readPromptFile(path: string): string {
  if (!existsSync(path)) die(`prompt_file not found: ${path}`);
  return readFileSync(path, 'utf8');
}
