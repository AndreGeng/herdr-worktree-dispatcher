import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { die } from '../utils/errors.js';
import { run } from '../utils/process.js';

export interface DispatcherConfig {
  agentCommand: string;
  agentArgs: string[];
  language: string;
  layoutPreset: 'right' | 'down';
  mergeInstruction: boolean;
  mergeMode: 'rebase' | 'merge';
}

export interface WorktreePreflightConfig {
  strict: boolean;
  prepareCommand?: string;
  verifyCommand?: string;
}

export interface ConfigSelection {
  configFile?: string;
  profile?: string;
  herdrBin: string;
  sourceCwd?: string;
}

export interface ResolvedConfigFiles {
  userConfigFile?: string;
  projectConfigFile?: string;
}

export function defaultConfig(): DispatcherConfig {
  return {
    agentCommand: process.env.HERDR_WORKTREE_AGENT || 'opencode',
    agentArgs: [],
    language: 'zh-CN',
    layoutPreset: 'right',
    mergeInstruction: false,
    mergeMode: 'rebase',
  };
}

export function resolveConfigFile(herdrBin: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  if (process.env.HERDR_WORKTREE_DISPATCHER_CONFIG) return process.env.HERDR_WORKTREE_DISPATCHER_CONFIG;
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    const pluginConfig = `${process.env.HERDR_PLUGIN_CONFIG_DIR}/config.env`;
    if (existsSync(pluginConfig)) return pluginConfig;
  }
  try {
    const configDir = run(herdrBin, ['plugin', 'config-dir', 'worktree.dispatcher']).trim();
    const configPath = `${configDir}/config.env`;
    if (existsSync(configPath)) return configPath;
  } catch {
    return undefined;
  }
  return undefined;
}

export function resolveProjectConfigFile(sourceCwd: string | undefined): string | undefined {
  if (!sourceCwd) return undefined;
  const projectConfig = join(sourceCwd, '.herdr-worktree-dispatcher', 'config.env');
  return existsSync(projectConfig) ? projectConfig : undefined;
}

export function resolveConfigFiles(selection: ConfigSelection): ResolvedConfigFiles {
  if (selection.configFile) return { userConfigFile: selection.configFile };
  return {
    userConfigFile: resolveConfigFile(selection.herdrBin),
    projectConfigFile: resolveProjectConfigFile(selection.sourceCwd),
  };
}

export function loadConfig(selection: ConfigSelection): DispatcherConfig {
  const config = defaultConfig();
  const configFiles = configFilesInPrecedenceOrder(resolveConfigFiles(selection));
  if (configFiles.length === 0) {
    if (selection.profile) die('--profile requires --config or HERDR_WORKTREE_DISPATCHER_CONFIG');
    return config;
  }
  for (const configFile of configFiles) applyConfigSection(config, configFile, 'default');
  if (selection.profile) {
    for (const configFile of configFiles) applyConfigSection(config, configFile, `profile.${selection.profile}`);
  }
  return config;
}

export function getMergedConfigSection(files: ResolvedConfigFiles, wantedSection: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const configFile of configFilesInPrecedenceOrder(files)) Object.assign(values, getConfigSection(configFile, wantedSection));
  return values;
}

export function resolveLanguage(files: ResolvedConfigFiles, profile?: string): string {
  const defaultSection = getMergedConfigSection(files, 'default');
  const profileSection = profile ? getMergedConfigSection(files, `profile.${profile}`) : {};
  if (profileSection.language !== undefined) return parseLanguage(profileSection.language, `profile.${profile}`);
  if (defaultSection.language !== undefined) return parseLanguage(defaultSection.language, 'default');
  return 'zh-CN';
}

export function loadWorktreePreflightConfig(input: { projectConfigFile?: string; profile?: string }): WorktreePreflightConfig {
  const files = { projectConfigFile: input.projectConfigFile };
  const section = getMergedConfigSection(files, 'worktree.preflight');
  const profileSection = input.profile ? getMergedConfigSection(files, `profile.${input.profile}.worktree.preflight`) : {};
  const values = { ...section, ...profileSection };
  for (const key of Object.keys(values)) {
    if (!['strict', 'prepare_command', 'verify_command'].includes(key)) die(`unknown config key in [worktree.preflight]: ${key}`);
  }
  return {
    strict: values.strict ? parseBool(values.strict) : false,
    prepareCommand: values.prepare_command,
    verifyCommand: values.verify_command,
  };
}

function configFilesInPrecedenceOrder(files: ResolvedConfigFiles): string[] {
  return [files.userConfigFile, files.projectConfigFile].filter((file): file is string => Boolean(file));
}

export function getConfigSection(configFile: string, wantedSection: string): Record<string, string> {
  if (!existsSync(configFile)) die(`config file not found: ${configFile}`);
  const values: Record<string, string> = {};
  const lines = readFileSync(configFile, 'utf8').split(/\r?\n/);
  let currentSection = '';
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      continue;
    }
    if (currentSection !== wantedSection) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) die(`invalid config line in [${wantedSection}]: ${line}`);
    values[line.slice(0, equalsIndex).trim()] = stripQuotes(line.slice(equalsIndex + 1).trim());
  }
  return values;
}

function applyConfigSection(config: DispatcherConfig, configFile: string, wantedSection: string): void {
  if (!existsSync(configFile)) die(`config file not found: ${configFile}`);
  const lines = readFileSync(configFile, 'utf8').split(/\r?\n/);
  let currentSection = '';
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      currentSection = line.slice(1, -1).trim();
      continue;
    }
    if (currentSection !== wantedSection) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex === -1) die(`invalid config line in [${wantedSection}]: ${line}`);
    const key = line.slice(0, equalsIndex).trim();
    const value = stripQuotes(line.slice(equalsIndex + 1).trim());
    switch (key) {
      case 'agent':
        config.agentCommand = value;
        break;
      case 'agent_arg':
        config.agentArgs.push(value);
        break;
      case 'language':
        config.language = parseLanguage(value, wantedSection);
        break;
      case 'layout':
        if (value !== 'right' && value !== 'down') die(`invalid layout in [${wantedSection}]: ${value}`);
        config.layoutPreset = value;
        break;
      case 'merge':
        config.mergeInstruction = parseBool(value);
        break;
      case 'merge_mode':
        if (value !== 'rebase' && value !== 'merge') die(`invalid merge_mode in [${wantedSection}]: ${value}`);
        config.mergeMode = value;
        break;
      case 'team':
        break;
      case 'placement':
      case 'worktree_mode':
        die(`config key '${key}' has been removed; Herdr worktree creation is now the only dispatch mode`);
      case 'cleanup':
        die("config key 'cleanup' has been removed; only add --merge creates a merge token");
      case 'prompt_template':
        die("config key 'prompt_template' has been removed; prompts are submitted to the started Herdr pane");
      default:
        die(`unknown config key in [${wantedSection}]: ${key}`);
    }
  }
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseLanguage(value: string, section: string): string {
  const language = value.trim();
  if (!language) die(`language must not be empty in [${section}]`);
  return language;
}

function parseBool(value: string): boolean {
  switch (value) {
    case 'true':
    case 'yes':
    case '1':
    case 'on':
      return true;
    case 'false':
    case 'no':
    case '0':
    case 'off':
      return false;
    default:
      die(`invalid boolean value: ${value}`);
  }
}
