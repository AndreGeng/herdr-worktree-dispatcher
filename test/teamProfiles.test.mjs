import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig, loadWorktreePreflightConfig, resolveConfigFiles, resolveLanguage } from '../dist/config/config.js';
import { loadTeamProfile, resolveTeamName, resolveWorkerAgent } from '../dist/team/profiles.js';

test('loads top-level language and built-in engineering role runtime overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-profile-'));
  const config = join(dir, 'config.env');
  writeFileSync(config, `[default]\nagent = opencode\nlanguage = en-US\nteam = engineering\n\n[team.engineering]\nleader_agent = pi\nworker_agent = codex\nworkers = reviewer:claude,tester:opencode\n\n[team.engineering.role.designer]\nname = UI Designer\ndescription = Review UX\nagent = claude\nsuccess = concrete design findings\n`);

  assert.equal(resolveTeamName(true, 'herdr', config), 'engineering');
  assert.equal(loadConfig({ herdrBin: 'herdr', configFile: config }).language, 'en-US');
  const profile = loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr', configFile: config });
  assert.equal(profile.leaderAgent, 'pi');
  assert.equal(resolveWorkerAgent(profile, 'reviewer'), 'claude');
  assert.equal(resolveWorkerAgent(profile, 'tester'), 'opencode');
  assert.equal(resolveWorkerAgent(profile, 'designer'), 'claude');
  assert.equal(profile.roles.find((role) => role.role === 'designer')?.success, 'concrete design findings');
});

test('dispatcher config defaults language to Chinese', () => {
  const config = withNoAmbientConfig(() => loadConfig({ herdrBin: 'herdr-not-found' }));
  const profile = withNoAmbientConfig(() => loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr-not-found' }));

  assert.equal(config.language, 'zh-CN');
  assert.equal(profile.leaderAgent, 'opencode');
  assert.equal(profile.defaultWorkerAgent, 'pi');
  assert.deepEqual(profile.workerAgentPool, ['claude', 'codex']);
  assert.deepEqual(profile.roles.map((role) => role.role), ['investigator', 'architect', 'implementer', 'reviewer', 'tester', 'docs', 'shipper']);
  assert.match(profile.roles.find((role) => role.role === 'investigator')?.description || '', /unclear problems/);
  assert.match(profile.roles.find((role) => role.role === 'architect')?.description || '', /technical approach/);
  assert.match(profile.roles.find((role) => role.role === 'architect')?.success || '', /technical design/);
});

test('worker runtime can be randomly selected from configured pool', () => {
  const previousRandom = Math.random;
  Math.random = () => 0.5;
  try {
    const profile = withNoAmbientConfig(() => loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr-not-found' }));
    assert.equal(resolveWorkerAgent(profile, 'implementer', undefined, () => true), 'codex');
  } finally {
    Math.random = previousRandom;
  }
});

test('worker runtime random pool ignores unavailable commands', () => {
  const previousRandom = Math.random;
  Math.random = () => 0;
  try {
    const profile = withNoAmbientConfig(() => loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr-not-found' }));
    assert.equal(resolveWorkerAgent(profile, 'implementer', undefined, (command) => command === 'pi'), 'pi');
  } finally {
    Math.random = previousRandom;
  }
});

test('worker runtime errors when no configured runtime is installed', () => {
  const profile = withNoAmbientConfig(() => loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr-not-found' }));

  assert.throws(
    () => resolveWorkerAgent(profile, 'implementer', undefined, () => false),
    /no installed worker runtime available for role: implementer \(tried: claude, codex, pi\)/,
  );
});

test('explicit worker runtime overrides random pool', () => {
  const previousRandom = Math.random;
  Math.random = () => 0.75;
  try {
    const profile = withNoAmbientConfig(() => loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr-not-found' }));
    assert.equal(resolveWorkerAgent(profile, 'implementer', 'claude'), 'claude');
  } finally {
    Math.random = previousRandom;
  }
});

test('explicit worker runtime must be installed', () => {
  const profile = withNoAmbientConfig(() => loadTeamProfile({ teamName: 'engineering', herdrBin: 'herdr-not-found' }));

  assert.throws(
    () => resolveWorkerAgent(profile, 'implementer', 'claude', () => false),
    /worker runtime is not installed for role implementer: claude/,
  );
});

test('roles field is the final role list and disabled_roles removes entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-profile-'));
  const config = join(dir, 'config.env');
  writeFileSync(config, `[team.product-ui]\nroles = designer,reviewer\ndisabled_roles = reviewer\n\n[team.product-ui.role.designer]\ndescription = Review UI\n`);
  const profile = loadTeamProfile({ teamName: 'product-ui', herdrBin: 'herdr', configFile: config });
  assert.deepEqual(profile.roles.map((role) => role.role), ['designer']);
});

test('project config overrides user config for dispatcher defaults', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'user-config-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'project-config-'));
  const userConfig = join(userDir, 'config.env');
  const projectConfigDir = join(projectDir, '.herdr-worktree-dispatcher');
  mkdirSync(projectConfigDir);
  writeFileSync(userConfig, '[default]\nagent = codex\nlanguage = en-US\nlayout = right\n');
  writeFileSync(join(projectConfigDir, 'config.env'), '[default]\nagent = opencode\nlanguage = zh-CN\nlayout = down\n');

  const files = resolveConfigFiles({ herdrBin: 'herdr', configFile: userConfig, sourceCwd: projectDir });
  assert.equal(files.projectConfigFile, undefined);
  const discovered = withNoAmbientConfig(() => {
    process.env.HERDR_WORKTREE_DISPATCHER_CONFIG = userConfig;
    return resolveConfigFiles({ herdrBin: 'herdr', sourceCwd: projectDir });
  });
  assert.equal(discovered.projectConfigFile, join(projectConfigDir, 'config.env'));
  const config = withNoAmbientConfig(() => {
    process.env.HERDR_WORKTREE_DISPATCHER_CONFIG = userConfig;
    return loadConfig({ herdrBin: 'herdr', sourceCwd: projectDir });
  });
  assert.equal(config.agentCommand, 'opencode');
  assert.equal(config.language, 'zh-CN');
  assert.equal(config.layoutPreset, 'down');
});

test('profile language overrides the default language', () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-language-'));
  const configFile = join(dir, 'config.env');
  writeFileSync(configFile, '[default]\nlanguage = zh-CN\n\n[profile.english]\nlanguage = en-US\n');

  const config = loadConfig({ herdrBin: 'herdr', configFile, profile: 'english' });

  assert.equal(config.language, 'en-US');
});

test('resolves language from a persisted team config selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persisted-team-language-'));
  const configFile = join(dir, 'config.env');
  writeFileSync(configFile, '[default]\nlanguage = zh-CN\n\n[profile.english]\nlanguage = en-US\n');

  assert.equal(resolveLanguage({ userConfigFile: configFile }, 'english'), 'en-US');
});

test('rejects an empty language', () => {
  const dir = mkdtempSync(join(tmpdir(), 'empty-language-'));
  const configFile = join(dir, 'config.env');
  writeFileSync(configFile, '[default]\nlanguage = "  "\n');

  assert.throws(
    () => loadConfig({ herdrBin: 'herdr', configFile }),
    /language must not be empty in \[default\]/,
  );
});

test('plain dispatcher config ignores team worker runtime settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plain-config-'));
  const configFile = join(dir, 'config.env');
  writeFileSync(configFile, '[default]\nagent = opencode\n\n[team.engineering]\nleader_agent = opencode\nworker_agent = pi\n');

  const config = loadConfig({ herdrBin: 'herdr', configFile });

  assert.equal(config.agentCommand, 'opencode');
});

test('worktree preflight config is read from project config only', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'project-config-'));
  const projectConfigDir = join(projectDir, '.herdr-worktree-dispatcher');
  mkdirSync(projectConfigDir);
  const projectConfig = join(projectConfigDir, 'config.env');
  writeFileSync(projectConfig, '[worktree.preflight]\nstrict = true\nprepare_command = make bootstrap\nverify_command = make test\n\n[profile.fast.worktree.preflight]\nverify_command = make quick-test\n');

  assert.deepEqual(loadWorktreePreflightConfig({ projectConfigFile: projectConfig }), {
    strict: true,
    prepareCommand: 'make bootstrap',
    verifyCommand: 'make test',
  });
  assert.deepEqual(loadWorktreePreflightConfig({ projectConfigFile: projectConfig, profile: 'fast' }), {
    strict: true,
    prepareCommand: 'make bootstrap',
    verifyCommand: 'make quick-test',
  });
});

function withNoAmbientConfig(fn) {
  const previousConfig = process.env.HERDR_WORKTREE_DISPATCHER_CONFIG;
  const previousPluginConfig = process.env.HERDR_PLUGIN_CONFIG_DIR;
  delete process.env.HERDR_WORKTREE_DISPATCHER_CONFIG;
  delete process.env.HERDR_PLUGIN_CONFIG_DIR;
  try {
    return fn();
  } finally {
    if (previousConfig === undefined) delete process.env.HERDR_WORKTREE_DISPATCHER_CONFIG;
    else process.env.HERDR_WORKTREE_DISPATCHER_CONFIG = previousConfig;
    if (previousPluginConfig === undefined) delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    else process.env.HERDR_PLUGIN_CONFIG_DIR = previousPluginConfig;
  }
}
