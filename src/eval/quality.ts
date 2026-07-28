import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalQualityMetrics } from './types.js';

export function analyzeQuality(cloneDir: string, task: { acceptance?: string[] }): EvalQualityMetrics {
  const diff = getDiff(cloneDir);
  const linesAdded = countLines(diff, /^\+[^+]/gm);
  const linesRemoved = countLines(diff, /^-[^-]/gm);
  const filesChanged = getFilesChanged(cloneDir);
  const testFiles = filesChanged.filter((f) => f.includes('test') || f.includes('spec'));
  const testLinesAdded = getTestLinesAdded(cloneDir, testFiles);
  const acceptanceResult = checkAcceptanceCriteria(cloneDir, task.acceptance || []);

  const qualityScore = computeQualityScore({
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_changed: filesChanged.length,
    test_files_added: testFiles.length,
    test_lines_added: testLinesAdded,
    acceptance_matched: acceptanceResult.matched,
    acceptance_total: acceptanceResult.total,
  });

  return {
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_changed: filesChanged.length,
    test_files_added: testFiles.length,
    test_lines_added: testLinesAdded,
    acceptance_matched: acceptanceResult.matched,
    acceptance_total: acceptanceResult.total,
    quality_score: qualityScore,
  };
}

function getDiff(cloneDir: string): string {
  try {
    return execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
      cwd: cloneDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function countLines(diff: string, pattern: RegExp): number {
  const matches = diff.match(pattern);
  return matches ? matches.length : 0;
}

function getFilesChanged(cloneDir: string): string[] {
  try {
    const output = execFileSync('git', ['diff', 'HEAD~1', 'HEAD', '--name-only'], {
      cwd: cloneDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getTestLinesAdded(cloneDir: string, testFiles: string[]): number {
  let total = 0;
  for (const file of testFiles) {
    const filePath = join(cloneDir, file);
    if (!existsSync(filePath)) continue;
    try {
      const diff = execFileSync('git', ['diff', 'HEAD~1', 'HEAD', '--', file], {
        cwd: cloneDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      total += countLines(diff, /^\+[^+]/gm);
    } catch {
      // ignore
    }
  }
  return total;
}

function checkAcceptanceCriteria(cloneDir: string, criteria: string[]): { matched: number; total: number } {
  if (criteria.length === 0) return { matched: 0, total: 0 };

  let matched = 0;
  for (const criterion of criteria) {
    if (checkSingleCriterion(cloneDir, criterion)) {
      matched++;
    }
  }
  return { matched, total: criteria.length };
}

function checkSingleCriterion(cloneDir: string, criterion: string): boolean {
  const lower = criterion.toLowerCase();

  if (lower.includes('test') && lower.includes('pass')) {
    return checkTestsPass(cloneDir);
  }
  if (lower.includes('export') || lower.includes('function')) {
    return checkFunctionExists(cloneDir, criterion);
  }
  if (lower.includes('file exists')) {
    return checkFileExists(cloneDir, criterion);
  }
  if (lower.includes('no change') || lower.includes('not change')) {
    return true;
  }
  return true;
}

function checkTestsPass(cloneDir: string): boolean {
  try {
    execFileSync('npm', ['test'], {
      cwd: cloneDir,
      timeout: 60_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function checkFunctionExists(cloneDir: string, criterion: string): boolean {
  const match = criterion.match(/['"]([^'"]+)['"]/);
  if (!match) return true;
  const funcName = match[1];
  try {
    const output = execFileSync('grep', ['-r', funcName, 'src/'], {
      cwd: cloneDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.includes(funcName);
  } catch {
    return false;
  }
}

function checkFileExists(cloneDir: string, criterion: string): boolean {
  const match = criterion.match(/['"]([^'"]+)['"]/);
  if (!match) return true;
  const filePath = match[1];
  return existsSync(join(cloneDir, filePath));
}

function computeQualityScore(metrics: {
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  test_files_added: number;
  test_lines_added: number;
  acceptance_matched: number;
  acceptance_total: number;
}): number {
  let score = 50;

  if (metrics.acceptance_total > 0) {
    const acceptanceRate = metrics.acceptance_matched / metrics.acceptance_total;
    score += acceptanceRate * 30;
  }

  if (metrics.test_files_added > 0) {
    score += 10;
  }
  if (metrics.test_lines_added > 10) {
    score += 5;
  }

  if (metrics.lines_added > 0 && metrics.lines_added < 200) {
    score += 5;
  }

  return Math.min(100, Math.round(score));
}
