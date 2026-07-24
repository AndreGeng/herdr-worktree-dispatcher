import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { findContentViolations, findIdentityViolations, parseDenylist } from '../scripts/check-public-hygiene.mjs';

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

test('hygiene scanner catches portable-path, tenant, and credential violations', () => {
  const personalPath = ['', 'Users', 'maintainer', 'repo'].join('/');
  const linuxPath = ['', 'home', 'maintainer', 'repo'].join('/');
  const windowsPath = ['C:', 'Users', 'Maintainer', 'repo'].join('\\');
  const tenantHost = ['https://workspace', 'feishu', 'cn/base'].join('.');
  const accessKey = `AKIA${'A'.repeat(16)}`;
  const violations = findContentViolations(`${personalPath}\n${linuxPath}\n${windowsPath}\n${tenantHost}\n${accessKey}`);

  assert.deepEqual(violations.map((violation) => violation.rule), [
    'personal-home-path',
    'personal-linux-home-path',
    'personal-windows-home-path',
    'non-placeholder-feishu-host',
    'aws-access-key',
  ]);
  assert.deepEqual(findContentViolations('https://tenant.feishu.cn/base/sample'), []);
});

test('private denylist reports labels without echoing private values', () => {
  const privateValue = ['private', 'codename'].join('-');
  const denylist = parseDenylist(`# Local values only\n${privateValue}\n`);
  const violations = findContentViolations(`mentions ${privateValue}`, denylist);

  assert.deepEqual(denylist, [privateValue]);
  assert.deepEqual(violations, [{ rule: 'private-denylist-entry' }]);
  assert.equal(JSON.stringify(violations).includes(privateValue), false);
  assert.throws(() => parseDenylist('x\n'), /at least two characters/);
});

test('commit identity policy accepts only GitHub noreply addresses', () => {
  assert.deepEqual(findIdentityViolations('Maintainer <123+maintainer@users.noreply.github.com>'), []);
  assert.deepEqual(findIdentityViolations('GitHub <noreply@github.com>'), []);
  assert.deepEqual(findIdentityViolations('Maintainer <maintainer@example.com>'), [
    { rule: 'non-public-commit-email' },
  ]);
});

test('CLI blocks staged content and reachable history without echoing matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'hygiene-repo-'));
  const denylist = join(root, 'denylist.txt');
  const scanner = join(process.cwd(), 'scripts', 'check-public-hygiene.mjs');
  const personalPath = ['', 'Users', 'maintainer', 'project'].join('/');
  writeFileSync(denylist, '# intentionally empty\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Example Maintainer'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'maintainer@users.noreply.github.com'], { cwd: root });
  writeFileSync(join(root, 'fixture.txt'), personalPath);
  execFileSync('git', ['add', 'fixture.txt'], { cwd: root });

  const env = { ...process.env, OPEN_SOURCE_DENYLIST_FILE: denylist };
  const staged = spawnSync(process.execPath, [scanner, '--staged'], { cwd: root, encoding: 'utf8', env });
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /fixture\.txt: personal-home-path/);
  assert.doesNotMatch(staged.stderr, /maintainer\/project/);

  execFileSync('git', ['commit', '-q', '-m', 'test fixture'], { cwd: root });
  const history = spawnSync(process.execPath, [scanner, '--history'], { cwd: root, encoding: 'utf8', env });
  assert.equal(history.status, 1);
  assert.match(history.stderr, /reachable Git blob: fixture\.txt: personal-home-path/);
  assert.doesNotMatch(history.stderr, /maintainer\/project/);
});

test('release hygiene requires an external private denylist', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hygiene-release-workspace-'));
  const root = join(workspace, 'repo');
  const scanner = join(process.cwd(), 'scripts', 'check-public-hygiene.mjs');
  mkdirSync(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Example Maintainer'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'maintainer@users.noreply.github.com'], { cwd: root });
  writeFileSync(join(root, 'safe.txt'), 'safe contents');
  execFileSync('git', ['add', 'safe.txt'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'safe commit'], { cwd: root });

  const result = spawnSync(process.execPath, [scanner, '--history', '--require-denylist'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: root },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /private denylist is required/);

  const externalEmpty = join(workspace, 'empty-denylist.txt');
  writeFileSync(externalEmpty, '# no entries\n');
  const emptyDenylist = spawnSync(process.execPath, [scanner, '--history', '--require-denylist'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: externalEmpty },
  });
  assert.equal(emptyDenylist.status, 2);
  assert.match(emptyDenylist.stderr, /private denylist must contain at least one entry/);

  const trackedDenylist = join(root, '.open-source-denylist.local');
  writeFileSync(trackedDenylist, 'private-term\n');
  execFileSync('git', ['add', '-f', '.open-source-denylist.local'], { cwd: root });
  const repositoryDenylist = spawnSync(process.execPath, [scanner, '--history', '--require-denylist'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: trackedDenylist },
  });
  assert.equal(repositoryDenylist.status, 2);
  assert.match(repositoryDenylist.stderr, /private denylist must be outside the repository/);
});

test('CLI scans private filenames and binary blobs without echoing matches', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hygiene-binary-repo-'));
  const root = join(workspace, 'repo');
  const denylistPath = join(workspace, 'denylist.txt');
  const scanner = join(process.cwd(), 'scripts', 'check-public-hygiene.mjs');
  const privateValue = ['private', 'codename'].join('-');
  const unicodeValue = String.fromCodePoint(0x5bc6, 0x7801);
  mkdirSync(root);
  writeFileSync(denylistPath, `${privateValue}\n${unicodeValue}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Example Maintainer'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'maintainer@users.noreply.github.com'], { cwd: root });
  writeFileSync(join(root, 'safe-alias.txt'), 'shared safe contents');
  writeFileSync(join(root, `${privateValue}.txt`), 'shared safe contents');
  writeFileSync(join(root, 'binary.bin'), Buffer.from(privateValue, 'utf16le'));
  writeFileSync(join(root, 'binary-be.bin'), Buffer.from(Buffer.from(privateValue, 'utf16le')).swap16());
  writeFileSync(join(root, 'binary-unicode-le.bin'), Buffer.from(unicodeValue, 'utf16le'));
  writeFileSync(join(root, 'binary-unicode-be.bin'), Buffer.from(Buffer.from(unicodeValue, 'utf16le')).swap16());
  execFileSync('git', ['add', '.'], { cwd: root });

  const result = spawnSync(process.execPath, [scanner, '--staged'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: denylistPath },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /repository path \(redacted\): private-denylist-entry/);
  assert.match(result.stderr, /binary\.bin: private-denylist-entry/);
  assert.match(result.stderr, /binary-be\.bin: private-denylist-entry/);
  assert.match(result.stderr, /binary-unicode-le\.bin: private-denylist-entry/);
  assert.match(result.stderr, /binary-unicode-be\.bin: private-denylist-entry/);
  assert.doesNotMatch(result.stderr, new RegExp(privateValue, 'i'));

  execFileSync('git', ['commit', '-q', '-m', 'binary fixture'], { cwd: root });
  const history = spawnSync(process.execPath, [scanner, '--history'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: denylistPath },
  });
  assert.equal(history.status, 1, history.stderr);
  assert.match(history.stderr, /repository path \(redacted\): private-denylist-entry/);
  assert.match(history.stderr, /reachable Git blob: binary\.bin: private-denylist-entry/);
  assert.match(history.stderr, /reachable Git blob: binary-be\.bin: private-denylist-entry/);
  assert.match(history.stderr, /reachable Git blob: binary-unicode-le\.bin: private-denylist-entry/);
  assert.match(history.stderr, /reachable Git blob: binary-unicode-be\.bin: private-denylist-entry/);
  assert.doesNotMatch(history.stderr, new RegExp(privateValue, 'i'));
});

test('history scan includes commit messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'hygiene-message-repo-'));
  const denylistPath = join(root, 'denylist.txt');
  const scanner = join(process.cwd(), 'scripts', 'check-public-hygiene.mjs');
  const privateValue = ['private', 'codename'].join('-');
  writeFileSync(denylistPath, `${privateValue}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Example Maintainer'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'maintainer@users.noreply.github.com'], { cwd: root });
  writeFileSync(join(root, 'safe.txt'), 'safe contents');
  execFileSync('git', ['add', 'safe.txt'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', `mentions ${privateValue}`], { cwd: root });

  const result = spawnSync(process.execPath, [scanner, '--history'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: denylistPath },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reachable commit metadata: private-denylist-entry/);
  assert.doesNotMatch(result.stderr, new RegExp(privateValue, 'i'));
});

test('history scan includes annotated tag messages', () => {
  const root = mkdtempSync(join(tmpdir(), 'hygiene-tag-repo-'));
  const denylistPath = join(root, 'denylist.txt');
  const scanner = join(process.cwd(), 'scripts', 'check-public-hygiene.mjs');
  const privateValue = ['private', 'codename'].join('-');
  writeFileSync(denylistPath, `${privateValue}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Example Maintainer'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'maintainer@users.noreply.github.com'], { cwd: root });
  writeFileSync(join(root, 'safe.txt'), 'safe contents');
  execFileSync('git', ['add', 'safe.txt'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'safe commit'], { cwd: root });
  execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', `mentions ${privateValue}`], { cwd: root });

  const result = spawnSync(process.execPath, [scanner, '--history'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: denylistPath },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reachable annotated tag metadata: private-denylist-entry/);
  assert.doesNotMatch(result.stderr, new RegExp(privateValue, 'i'));
});

test('history scan includes lightweight and annotated tag names', () => {
  const root = mkdtempSync(join(tmpdir(), 'hygiene-tag-name-repo-'));
  const denylistPath = join(root, 'denylist.txt');
  const scanner = join(process.cwd(), 'scripts', 'check-public-hygiene.mjs');
  const privateValue = ['private', 'codename'].join('-');
  writeFileSync(denylistPath, `${privateValue}\n`);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Example Maintainer'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'maintainer@users.noreply.github.com'], { cwd: root });
  writeFileSync(join(root, 'safe.txt'), 'safe contents');
  execFileSync('git', ['add', 'safe.txt'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'safe commit'], { cwd: root });
  execFileSync('git', ['tag', privateValue], { cwd: root });

  const result = spawnSync(process.execPath, [scanner, '--history'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, OPEN_SOURCE_DENYLIST_FILE: denylistPath },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository path \(redacted\): private-denylist-entry/);
  assert.doesNotMatch(result.stderr, new RegExp(privateValue, 'i'));
});

test('repository hooks enforce staged and history hygiene checks', () => {
  const preCommit = readFileSync('.githooks/pre-commit', 'utf8');
  const prePush = readFileSync('.githooks/pre-push', 'utf8');
  const installer = readFileSync('scripts/install-git-hooks.sh', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.match(preCommit, /check-public-hygiene\.mjs/);
  assert.match(preCommit, /--staged/);
  assert.match(prePush, /check-public-hygiene\.mjs/);
  assert.match(prePush, /--history/);
  assert.match(installer, /--absolute-git-dir/);
  assert.match(installer, /cp .*check-public-hygiene\.mjs/);
  assert.equal(packageJson.scripts['hygiene:staged'], 'node scripts/check-public-hygiene.mjs --staged');
  assert.equal(packageJson.scripts['hygiene:history'], 'node scripts/check-public-hygiene.mjs --history');
  assert.equal(packageJson.scripts['hygiene:release'], 'node scripts/check-public-hygiene.mjs --history --require-denylist');
  assert.equal(packageJson.scripts['prepublishOnly'], 'npm run release:check');
  assert.equal(packageJson.scripts['hooks:install'], 'bash scripts/install-git-hooks.sh');
  assert.equal(packageJson.files.includes('.githooks/'), true);
  assert.equal(packageJson.files.includes('scripts/check-public-hygiene.mjs'), true);
  assert.equal(packageJson.files.includes('scripts/install-git-hooks.sh'), true);
});

test('package and plugin release metadata agree', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const plugin = readFileSync('herdr-plugin.toml', 'utf8');

  assert.equal(packageJson.version, '0.2.0');
  assert.match(plugin, /^version = "0\.2\.0"$/m);
  assert.equal(packageJson.repository.url, 'git+https://github.com/AndreGeng/herdr-worktree-dispatcher.git');
  assert.equal(packageJson.bugs.url, 'https://github.com/AndreGeng/herdr-worktree-dispatcher/issues');
  assert.equal(packageJson.homepage, 'https://github.com/AndreGeng/herdr-worktree-dispatcher#readme');
});

test('CI pins actions and runs all publication gates', () => {
  const workflows = readdirSync('.github/workflows')
    .filter((path) => /\.ya?ml$/.test(path))
    .map((path) => readFileSync(join('.github/workflows', path), 'utf8'));
  const workflow = workflows.join('\n');
  const actionRefs = workflows.flatMap((contents) => (
    [...contents.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])
  )).filter((reference) => !reference.startsWith('./'));

  assert.match(workflow, /permissions:\n  contents: read/);
  assert.equal((workflow.match(/^permissions:/gm) || []).length, 1);
  assert.equal(actionRefs.length > 0, true);
  assert.equal(actionRefs.every((reference) => /@[0-9a-f]{40}$/.test(reference)), true);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /tags:\n\s+- '\*'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm run hygiene:history/);
  assert.match(workflow, /npm run check/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /OPEN_SOURCE_DENYLIST/);
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
