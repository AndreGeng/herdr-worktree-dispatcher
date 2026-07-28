import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalGradeResult, EvalRunResult } from './types.js';

export function evalRunDir(baseDir: string, evalRunId: string, arm: string, taskId: string, repetition: number): string {
  return join(baseDir, evalRunId, arm, `${taskId}`, `rep-${repetition}`);
}

export function ensureEvalDirs(baseDir: string, evalRunId: string): void {
  mkdirSync(join(baseDir, evalRunId), { recursive: true });
  mkdirSync(join(baseDir, evalRunId, 'solo'), { recursive: true });
  mkdirSync(join(baseDir, evalRunId, 'team'), { recursive: true });
}

export function collectRunResult(artifactDir: string): EvalRunResult | undefined {
  const runJsonPath = join(artifactDir, 'run.json');
  if (!existsSync(runJsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(runJsonPath, 'utf8')) as EvalRunResult;
  } catch {
    return undefined;
  }
}

export function collectGradeResult(artifactDir: string): EvalGradeResult | undefined {
  const gradeJsonPath = join(artifactDir, 'grade.json');
  if (!existsSync(gradeJsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(gradeJsonPath, 'utf8')) as EvalGradeResult;
  } catch {
    return undefined;
  }
}

export function dirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  const stat = statSync(dirPath);
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(dirPath)) {
    total += dirSize(join(dirPath, entry));
  }
  return total;
}

export function listEvalRuns(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir).filter((entry) => {
    const fullPath = join(baseDir, entry);
    return statSync(fullPath).isDirectory();
  });
}
