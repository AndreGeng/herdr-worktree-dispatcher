#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_RULES = [
  { rule: 'personal-home-path', pattern: /\/Users\/(?!example(?:\/|$))[^/\s"'`]+/ },
  { rule: 'personal-linux-home-path', pattern: /\/home\/(?!developer(?:\/|$)|example(?:\/|$)|user(?:\/|$))[^/\s"'`]+/ },
  { rule: 'personal-windows-home-path', pattern: /[A-Za-z]:\\Users\\(?!developer(?:\\|$)|example(?:\\|$)|user(?:\\|$))[^\\\s"'`]+/i },
  { rule: 'non-placeholder-feishu-host', pattern: /https:\/\/(?!tenant\.feishu\.cn(?:[/:?]|$))[a-z0-9-]+\.feishu\.cn\b/i },
  { rule: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'github-access-token', pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/ },
  { rule: 'slack-access-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: 'service-api-key', pattern: /\bsk-(?:live|test|proj)-[A-Za-z0-9_-]{16,}\b/ },
  { rule: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
];

const MODES = new Set(['--staged', '--tracked', '--history']);
const MAX_BUFFER = 128 * 1024 * 1024;

export function parseDenylist(contents) {
  const entries = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  const tooShort = entries.find((entry) => Array.from(entry).length < 2);
  if (tooShort) throw new Error('private denylist entries must contain at least two characters');
  return [...new Set(entries)];
}

export function findContentViolations(contents, denylist = []) {
  const violations = [];
  for (const rule of PUBLIC_RULES) {
    if (rule.pattern.test(contents)) violations.push({ rule: rule.rule });
  }

  const folded = contents.toLocaleLowerCase();
  for (const entry of denylist) {
    if (folded.includes(entry.toLocaleLowerCase())) {
      violations.push({ rule: 'private-denylist-entry' });
    }
  }
  return violations;
}

export function findIdentityViolations(contents) {
  const emails = [...contents.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((match) => match[1]);
  const hasPrivateAddress = emails.some((email) => (
    email.toLocaleLowerCase() !== 'noreply@github.com'
      && !email.toLocaleLowerCase().endsWith('@users.noreply.github.com')
  ));
  return hasPrivateAddress ? [{ rule: 'non-public-commit-email' }] : [];
}

function runGit(args, encoding = 'utf8') {
  return execFileSync('git', args, { encoding, maxBuffer: MAX_BUFFER });
}

function readPrivateDenylist(required) {
  const configured = process.env.OPEN_SOURCE_DENYLIST_FILE;
  const candidates = configured
    ? [resolve(configured)]
    : [
        resolve('.open-source-denylist.local'),
        resolve(homedir(), '.config', 'herdr-worktree-dispatcher', 'open-source-denylist.txt'),
      ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (configured && !path) throw new Error('OPEN_SOURCE_DENYLIST_FILE does not exist');
  if (required && !path) throw new Error('private denylist is required for this scan');
  if (required) {
    const repository = resolve(runGit(['rev-parse', '--show-toplevel']).trim());
    const resolvedPath = realpathSync(path);
    if (resolvedPath === repository || resolvedPath.startsWith(`${repository}${sep}`)) {
      throw new Error('private denylist must be outside the repository for this scan');
    }
  }
  const entries = path ? parseDenylist(readFileSync(path, 'utf8')) : [];
  if (required && entries.length === 0) throw new Error('private denylist must contain at least one entry');
  return entries;
}

function searchableContents(buffer) {
  const variants = [buffer.toString('utf8'), buffer.toString('latin1')];
  if (buffer.length % 2 === 0) {
    variants.push(buffer.toString('utf16le'));
    variants.push(Buffer.from(buffer).swap16().toString('utf16le'));
  }
  return variants.join('\n');
}

function stagedSources() {
  const paths = runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
  const sources = paths.flatMap((path) => {
    const contents = runGit(['show', `:${path}`], 'buffer');
    return [{ source: path, path, contents: searchableContents(contents) }];
  });
  sources.push({ source: 'pending commit identity', contents: runGit(['var', 'GIT_AUTHOR_IDENT']), identity: true });
  sources.push({ source: 'pending committer identity', contents: runGit(['var', 'GIT_COMMITTER_IDENT']), identity: true });
  return sources;
}

function trackedSources() {
  return runGit(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((path) => ({
      source: path,
      path,
      contents: searchableContents(runGit(['show', `:${path}`], 'buffer')),
    }));
}

function historySources() {
  const contentsByObject = new Map();
  const seenEntries = new Set();
  const scannedBlobs = new Set();
  const blobs = [];
  for (const commit of runGit(['rev-list', '--all']).split('\n').filter(Boolean)) {
    for (const entry of runGit(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean)) {
      const match = /^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, object, path] = match;
      const entryKey = `${object}\0${path}`;
      if (seenEntries.has(entryKey)) continue;
      seenEntries.add(entryKey);
      if (!contentsByObject.has(object)) {
        contentsByObject.set(object, searchableContents(runGit(['cat-file', '-p', object], 'buffer')));
      }
      const contents = scannedBlobs.has(object) ? '' : contentsByObject.get(object);
      scannedBlobs.add(object);
      blobs.push({ source: `reachable Git blob: ${path}`, path, contents });
    }
  }
  const metadata = [{
    source: 'reachable commit metadata',
    contents: runGit(['log', '--all', '--format=fuller', '--no-patch']),
    identity: true,
  }];
  const tags = runGit(['for-each-ref', '--format=%(refname:strip=2)%09%(objecttype)%09%(objectname)', 'refs/tags'])
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [tag, type, object] = line.split('\t');
      const tagSource = { source: `reachable tag: ${tag}`, path: tag, contents: tag };
      return type === 'tag'
        ? [tagSource, { source: 'reachable annotated tag metadata', contents: runGit(['cat-file', '-p', object]), identity: true }]
        : [tagSource];
    });
  return [...blobs, ...metadata, ...tags];
}

function scan(mode, denylist) {
  const sources = mode === '--staged'
    ? stagedSources()
    : mode === '--tracked'
      ? trackedSources()
      : historySources();
  return sources.flatMap(({ source, path, contents, identity }) => {
    const pathViolations = path ? findContentViolations(path, denylist) : [];
    const safeSource = pathViolations.length > 0 ? 'repository path (redacted)' : source;
    const violations = [...pathViolations, ...findContentViolations(contents, denylist)];
    if (identity) violations.push(...findIdentityViolations(contents));
    return violations.map(({ rule }) => ({ source: safeSource, rule }));
  });
}

function main() {
  const [mode = '--tracked', ...flags] = process.argv.slice(2);
  const requireDenylist = flags.includes('--require-denylist');
  if (!MODES.has(mode) || flags.some((flag) => flag !== '--require-denylist') || flags.length > 1) {
    console.error('usage: node scripts/check-public-hygiene.mjs [--staged|--tracked|--history] [--require-denylist]');
    process.exitCode = 2;
    return;
  }

  try {
    const denylist = readPrivateDenylist(requireDenylist);
    const violations = scan(mode, denylist);
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(`hygiene violation: ${violation.source}: ${violation.rule}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`hygiene ok: ${mode.slice(2)} content${denylist.length ? ' with private denylist' : ''}`);
  } catch (error) {
    console.error(`hygiene check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
