import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalQualityMetrics } from './types.js';

export interface ScoringDetail {
  category: string;
  points: number;
  max_points: number;
  reason: string;
}

export function analyzeQuality(cloneDir: string, task: { acceptance?: string[] }): EvalQualityMetrics {
  const diff = getDiff(cloneDir);
  const linesAdded = countLines(diff, /^\+[^+]/gm);
  const linesRemoved = countLines(diff, /^-[^-]/gm);
  const filesChanged = getFilesChanged(cloneDir);
  const testFiles = filesChanged.filter((f) => f.includes('test') || f.includes('spec'));
  const testLinesAdded = getTestLinesAdded(cloneDir, testFiles);
  const acceptanceResult = checkAcceptanceCriteria(cloneDir, task.acceptance || []);

  const scoringDetails = computeScoringDetails({
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_changed: filesChanged.length,
    test_files_added: testFiles.length,
    test_lines_added: testLinesAdded,
    acceptance_matched: acceptanceResult.matched,
    acceptance_total: acceptanceResult.total,
  });

  const qualityScore = scoringDetails.reduce((sum, d) => sum + d.points, 0);

  return {
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_changed: filesChanged.length,
    test_files_added: testFiles.length,
    test_lines_added: testLinesAdded,
    acceptance_matched: acceptanceResult.matched,
    acceptance_total: acceptanceResult.total,
    quality_score: qualityScore,
    scoring_details: scoringDetails,
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

function computeScoringDetails(metrics: {
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  test_files_added: number;
  test_lines_added: number;
  acceptance_matched: number;
  acceptance_total: number;
}): ScoringDetail[] {
  const details: ScoringDetail[] = [];

  // Base score for completing the task
  details.push({
    category: 'task_completion',
    points: 50,
    max_points: 50,
    reason: 'Task completed and committed',
  });

  // Acceptance criteria
  if (metrics.acceptance_total > 0) {
    const acceptanceRate = metrics.acceptance_matched / metrics.acceptance_total;
    const points = Math.round(acceptanceRate * 30);
    details.push({
      category: 'acceptance_criteria',
      points,
      max_points: 30,
      reason: `${metrics.acceptance_matched}/${metrics.acceptance_total} criteria met (${Math.round(acceptanceRate * 100)}%)`,
    });
  } else {
    details.push({
      category: 'acceptance_criteria',
      points: 30,
      max_points: 30,
      reason: 'No acceptance criteria defined',
    });
  }

  // Test coverage
  if (metrics.test_files_added > 0) {
    details.push({
      category: 'test_coverage',
      points: 10,
      max_points: 10,
      reason: `Added ${metrics.test_files_added} test file(s)`,
    });
  } else {
    details.push({
      category: 'test_coverage',
      points: 0,
      max_points: 10,
      reason: 'No test files added',
    });
  }

  // Test thoroughness
  if (metrics.test_lines_added > 50) {
    details.push({
      category: 'test_thoroughness',
      points: 5,
      max_points: 5,
      reason: `Comprehensive tests (${metrics.test_lines_added} lines)`,
    });
  } else if (metrics.test_lines_added > 10) {
    details.push({
      category: 'test_thoroughness',
      points: 3,
      max_points: 5,
      reason: `Basic tests (${metrics.test_lines_added} lines)`,
    });
  } else {
    details.push({
      category: 'test_thoroughness',
      points: 0,
      max_points: 5,
      reason: 'Minimal or no test code',
    });
  }

  // Code quality (minimal changes preferred)
  if (metrics.lines_added > 0 && metrics.lines_added < 100) {
    details.push({
      category: 'code_quality',
      points: 5,
      max_points: 5,
      reason: `Minimal changes (${metrics.lines_added} lines added)`,
    });
  } else if (metrics.lines_added >= 100 && metrics.lines_added < 300) {
    details.push({
      category: 'code_quality',
      points: 3,
      max_points: 5,
      reason: `Moderate changes (${metrics.lines_added} lines added)`,
    });
  } else {
    details.push({
      category: 'code_quality',
      points: 1,
      max_points: 5,
      reason: `Large changes (${metrics.lines_added} lines added)`,
    });
  }

  return details;
}
