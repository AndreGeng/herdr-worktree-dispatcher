import type { Command } from 'commander';

import { runInstall, type InstallOptions } from './install.js';
import { repoRootFromMeta } from '../utils/paths.js';
import { runInherit } from '../utils/process.js';

interface InitOptions extends InstallOptions {
  pluginOnly?: boolean;
  skipBuild?: boolean;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Build this checkout and initialize the local Herdr plugin environment')
    .option('--agent <name>', 'Skill target agent: opencode, claude, codex, pi, or all', collect, [])
    .option('--skill-dir <path>', 'Custom skill install root', collect, [])
    .option('--plugin-only', 'Only link/create Herdr plugin config; do not install companion skills')
    .option('--skip-skill', 'Deprecated alias for --skip-skills')
    .option('--skip-skills', 'Do not install skills')
    .option('--force-config', 'Overwrite existing config.env')
    .option('--force-skill', 'Overwrite existing installed skill')
    .option('--skip-commands', 'Do not install shortcut commands')
    .option('--force-command', 'Overwrite existing installed shortcut commands')
    .option('--command-dir <path>', 'Custom Claude-style command install root', collect, [])
    .option('--copy-skill', 'Copy the skill instead of symlinking it')
    .option('--link-skill', 'Symlink the skill instead of copying it')
    .option('--skip-build', 'Do not run npm run build before initialization')
    .option('--no-hooks', 'Do not install agent trace hooks')
    .action((options: InitOptions) => runInit(options));
}

export function runInit(options: InitOptions): void {
  const packageRoot = repoRootFromMeta(import.meta.url);
  if (!options.skipBuild) {
    runInherit('npm', ['run', 'build'], { cwd: packageRoot });
  }
  runInstall({
    ...options,
    configOnly: options.pluginOnly,
    linkSkill: options.linkSkill ?? true,
  });
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}
