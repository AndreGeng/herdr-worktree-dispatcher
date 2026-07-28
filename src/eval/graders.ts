import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { EvalGrade, EvalGradeResult, EvalGraderDef } from './types.js';

export function gradeTaskResult(
  taskDir: string,
  task: { id: string; graders: EvalGraderDef[] },
  arm: string,
  repetition: number,
): EvalGradeResult {
  const results: EvalGradeResult['graders'] = [];

  for (const grader of task.graders) {
    const label = grader.label || grader.type;
    if (grader.type === 'command' || grader.type === 'hidden-command') {
      const commandDir = grader.type === 'hidden-command'
        ? join(process.cwd(), 'evals', 'graders', task.id)
        : taskDir;
      const result = runGraderCommand(commandDir, grader.command);
      results.push({ label, type: grader.type, passed: result.passed, output: result.output, error: result.error });
    } else if (grader.type === 'file-exists') {
      const filePath = join(taskDir, grader.path);
      const passed = existsSync(filePath);
      results.push({ label, type: grader.type, passed, error: passed ? undefined : `file not found: ${grader.path}` });
    } else if (grader.type === 'no-file-changes') {
      results.push({ label, type: grader.type, passed: true });
    }
  }

  const overall = computeOverallGrade(results);
  return { task_id: task.id, arm: arm as EvalGradeResult['arm'], repetition, overall, graders: results };
}

function runGraderCommand(cwd: string, command: string): { passed: boolean; output: string; error?: string } {
  try {
    const stdout = execFileSync('sh', ['-c', command], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true, output: stdout.trim() };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      passed: false,
      output: (err.stdout ?? '').trim(),
      error: (err.stderr ?? err.message ?? '').trim(),
    };
  }
}

function computeOverallGrade(results: EvalGradeResult['graders']): EvalGrade {
  for (const r of results) {
    if (!r.passed) return 'fail';
  }
  return results.length > 0 ? 'pass' : 'fail';
}

export function buildGraderDir(suiteName: string): string {
  const dir = join(process.cwd(), 'evals', 'graders', suiteName);
  mkdirSync(dir, { recursive: true });
  return dir;
}
