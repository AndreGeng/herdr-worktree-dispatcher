import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const forbidden = [
  { label: 'personal macOS home path', pattern: /\/Users\/(?!example(?:\/|$))[^/\s"'`]+/ },
  { label: 'non-placeholder Feishu host', pattern: /https:\/\/(?!tenant\.feishu\.cn(?:[/:?]|$))[a-z0-9-]+\.feishu\.cn\b/i },
];

test('public hygiene rules are explicit rather than obfuscated', () => {
  const source = readFileSync('test/openSourceHygiene.test.mjs', 'utf8');
  assert.doesNotMatch(source, /new RegExp\([^;\n]*\.join\(/);
});

const wrapperContents = readFileSync('skills/worktree-dispatcher/scripts/dispatch.sh', 'utf8');

test('tracked public files use portable paths and placeholder Feishu hosts', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter((path) => path && /\.(?:env|json|md|mjs|sh|toml|ts)$/.test(path));
  const violations = [];

  for (const path of files) {
    const contents = readFileSync(path, 'utf8');
    for (const rule of forbidden) {
      if (rule.pattern.test(contents)) violations.push(`${path}: ${rule.label}`);
    }
  }

  assert.deepEqual(violations, []);
});

test('packaged skill wrapper resolves the package dispatcher without a machine-specific path', () => {
  const output = execFileSync('bash', ['skills/worktree-dispatcher/scripts/dispatch.sh', '--help'], { encoding: 'utf8' });

  assert.match(output, /Usage: herdr-worktree-dispatcher/);
});

test('skill wrapper resolves a package-relative dispatcher through a directory symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'dispatcher-wrapper-'));
  const packageRoot = join(root, 'package');
  const packageSkill = join(packageRoot, 'skills', 'worktree-dispatcher');
  const wrapper = join(packageSkill, 'scripts', 'dispatch.sh');
  const packageDispatcher = join(packageRoot, 'scripts', 'dispatch.sh');
  const installedSkill = join(root, 'agent', 'skills', 'worktree-dispatcher');
  const workspace = join(root, 'workspace');
  mkdirSync(dirname(wrapper), { recursive: true });
  mkdirSync(dirname(packageDispatcher), { recursive: true });
  mkdirSync(dirname(installedSkill), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(wrapper, wrapperContents);
  writeFileSync(packageDispatcher, '#!/bin/sh\nprintf "package-dispatcher\\n"\n');
  symlinkSync(packageSkill, installedSkill, 'dir');

  const output = execFileSync('/bin/bash', [join(installedSkill, 'scripts', 'dispatch.sh')], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });

  assert.equal(output, 'package-dispatcher\n');
});

test('copied skill wrapper falls back to the installed CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'dispatcher-wrapper-cli-'));
  const wrapper = join(root, 'copied-skill', 'scripts', 'dispatch.sh');
  const cli = join(root, 'bin', 'herdr-worktree-dispatcher');
  const workspace = join(root, 'workspace');
  mkdirSync(dirname(wrapper), { recursive: true });
  mkdirSync(dirname(cli), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(wrapper, wrapperContents);
  writeFileSync(cli, '#!/bin/sh\nprintf "installed-cli\\n"\n');
  chmodSync(cli, 0o755);

  const output = execFileSync('/bin/bash', [wrapper], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dirname(cli)}:/usr/bin:/bin` },
  });

  assert.equal(output, 'installed-cli\n');
});
