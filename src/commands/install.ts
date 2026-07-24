import { cpSync, existsSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { installCommands } from '../install/commandTargets.js';
import { installDetectedHooks } from '../install/hookTargets.js';
import { parseSkillAgent, resolveSkillRoots, type SkillAgent } from '../install/skillTargets.js';
import { die } from '../utils/errors.js';
import { repoRootFromMeta } from '../utils/paths.js';
import { requireCommand, run } from '../utils/process.js';

export interface InstallOptions {
  agent?: string[];
  skillDir?: string[];
  skipPlugin?: boolean;
  skipConfig?: boolean;
  skipSkills?: boolean;
  skipSkill?: boolean;
  forceConfig?: boolean;
  forceSkill?: boolean;
  copySkill?: boolean;
  linkSkill?: boolean;
  configOnly?: boolean;
  skipLink?: boolean;
  skillRoot?: string;
  hooks?: boolean;
  skipCommands?: boolean;
  forceCommand?: boolean;
  commandDir?: string[];
}

export function registerInstall(program: Command): void {
  program
    .command('install')
    .description('Install the Herdr plugin config and companion skills')
    .option('--agent <name>', 'Skill target agent: opencode, claude, codex, pi, or all', collect, [])
    .option('--skill-dir <path>', 'Custom skill install root', collect, [])
    .option('--skip-plugin', 'Do not run herdr plugin link')
    .option('--skip-config', 'Do not create Herdr plugin config')
    .option('--skip-skills', 'Do not install skills')
    .option('--skip-skill', 'Deprecated alias for --skip-skills')
    .option('--force-config', 'Overwrite existing config.env')
    .option('--force-skill', 'Overwrite existing installed skill')
    .option('--copy-skill', 'Copy the skill instead of symlinking it')
    .option('--link-skill', 'Symlink the skill instead of copying it')
    .option('--config-only', 'Only create/update Herdr plugin config')
    .option('--skip-link', 'Alias for --skip-plugin')
    .option('--skill-root <path>', 'Deprecated alias for --skill-dir')
    .option('--skip-commands', 'Do not install shortcut commands')
    .option('--force-command', 'Overwrite existing installed shortcut commands')
    .option('--command-dir <path>', 'Custom Claude-style command install root', collect, [])
    .option('--no-hooks', 'Do not install agent trace hooks')
    .action((options: InstallOptions) => runInstall(options));
}

export function runInstall(options: InstallOptions): void {
  const packageRoot = repoRootFromMeta(import.meta.url);
  const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
  const skipPlugin = Boolean(options.skipPlugin || options.skipLink || options.configOnly);
  const skipSkills = Boolean(options.skipSkills || options.skipSkill || options.configOnly);
  const installConfig = !options.skipConfig;
  const forceConfig = Boolean(options.forceConfig);
  const forceSkill = Boolean(options.forceSkill);
  const forceCommand = Boolean(options.forceCommand);
  const copySkill = options.linkSkill ? false : trueIfUnset(options.copySkill, isNpmPackageInstall(packageRoot));
  const customSkillDirs = [...(options.skillDir ?? [])];
  if (options.skillRoot) customSkillDirs.push(options.skillRoot);

  if (options.configOnly && options.skipConfig) die('--config-only cannot be combined with --skip-config');
  if (options.copySkill && options.linkSkill) die('use either --copy-skill or --link-skill, not both');

  requireCommand(herdrBin);

  if (!skipPlugin) {
    info(`Linking Herdr plugin: ${packageRoot}`);
    run(herdrBin, ['plugin', 'link', packageRoot]);
  }

  if (installConfig) {
    const configDir = run(herdrBin, ['plugin', 'config-dir', 'worktree.dispatcher']).trim();
    const configPath = join(configDir, 'config.env');
    mkdirSync(configDir, { recursive: true });
    if (existsSync(configPath) && !forceConfig) {
      info(`Keeping existing config: ${configPath}`);
    } else {
      cpSync(join(packageRoot, 'examples', 'config.env'), configPath);
      info(`Installed config: ${configPath}`);
    }
  }

  if (!skipSkills) {
    const agents = (options.agent ?? []).map((agent) => {
      try {
        return parseSkillAgent(agent);
      } catch (error) {
        die((error as Error).message);
      }
    });
    const targets = resolveSkillRoots({ agents: agents as Array<SkillAgent | 'all'>, customSkillDirs });
    if (targets.length === 0) {
      info('No agent skill directories detected. Re-run with --agent all or --skill-dir PATH to install skills.');
    }
    for (const target of targets) {
      installSkill({
        sourceSkill: join(packageRoot, 'skills', 'worktree-dispatcher'),
        targetRoot: target.root,
        label: target.agent,
        copySkill,
        forceSkill,
      });
    }
  }

  if (!options.skipCommands && !options.configOnly) {
    const agents = (options.agent ?? []).map((agent) => {
      try {
        return parseSkillAgent(agent);
      } catch (error) {
        die((error as Error).message);
      }
    });
    info('Installing shortcut commands:');
    for (const result of installCommands({
      agents: agents as Array<SkillAgent | 'all'>,
      customCommandDirs: options.commandDir ?? [],
      packageRoot,
      forceCommand,
    })) {
      const detail = result.reason ? ` (${result.reason})` : '';
      info(`  ${result.agent}/${result.command}: ${result.status}${result.path ? ` ${result.path}` : ''}${detail}`);
    }
  }

  if (options.hooks !== false) {
    info('Installing agent trace hooks:');
    for (const result of installDetectedHooks(dispatchBinCommand(packageRoot))) {
      const detail = result.reason ? ` (${result.reason})` : '';
      info(`  ${result.agent}: ${result.status}${result.path ? ` ${result.path}` : ''}${detail}`);
    }
  }

  info(`Install complete. Verify with: ${herdrBin} plugin action list --plugin worktree.dispatcher`);
}

function dispatchBinCommand(packageRoot: string): string {
  if (isNpmPackageInstall(packageRoot)) return 'herdr-worktree-dispatcher';
  return `node ${join(packageRoot, 'dist', 'cli.js')}`;
}

function installSkill(input: {
  sourceSkill: string;
  targetRoot: string;
  label: string;
  copySkill: boolean;
  forceSkill: boolean;
}): void {
  const targetSkill = join(input.targetRoot, 'worktree-dispatcher');
  mkdirSync(input.targetRoot, { recursive: true });
  if (existsSync(targetSkill)) {
    if (isMatchingSymlink(targetSkill, input.sourceSkill)) {
      info(`Skill already linked for ${input.label}: ${targetSkill}`);
      return;
    }
    if (!input.forceSkill) {
      info(`Keeping existing skill for ${input.label}: ${targetSkill}`);
      return;
    }
    rmSync(targetSkill, { recursive: true, force: true });
  }
  if (input.copySkill) {
    cpSync(input.sourceSkill, targetSkill, { recursive: true });
    info(`Installed skill copy for ${input.label}: ${targetSkill}`);
  } else {
    symlinkSync(input.sourceSkill, targetSkill, 'dir');
    info(`Linked skill for ${input.label}: ${targetSkill}`);
  }
}

function isMatchingSymlink(path: string, target: string): boolean {
  try {
    return readlinkSync(path) === target;
  } catch {
    return false;
  }
}

function isNpmPackageInstall(packageRoot: string): boolean {
  return packageRoot.includes('/node_modules/') || packageRoot.includes('node_modules');
}

function trueIfUnset(value: boolean | undefined, fallback: boolean): boolean {
  return value ?? fallback;
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function info(message: string): void {
  process.stderr.write(`${message}\n`);
}
