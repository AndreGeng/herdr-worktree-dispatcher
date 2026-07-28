import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { die } from '../utils/errors.js';
import type { EvalTask, EvalTaskFixture } from './types.js';

export interface EvalSuiteManifest {
  name: string;
  version: string;
  description?: string;
  defaults: {
    wall_seconds: number;
    repetitions: number;
    agent: string;
    agent_args?: string[];
    team_profile?: string;
    team_leader_agent?: string;
    team_leader_args?: string[];
    team_worker_agent?: string;
    team_worker_args?: string[];
    team_agent_args?: string[];
  };
  tasks: Array<{
    id: string;
    name: string;
    category: string;
    difficulty: string;
    fixture: EvalTaskFixture;
    prompt: string;
    acceptance?: string[];
    limits?: { wall_seconds?: number; max_retries?: number };
    graders: EvalTask['graders'];
    critical?: boolean;
  }>;
}

export function loadEvalSuite(suitePath: string): EvalSuiteManifest {
  if (!existsSync(suitePath)) die(`eval suite not found: ${suitePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(suitePath, 'utf8'));
  } catch {
    die(`eval suite is not valid JSON: ${suitePath}`);
  }
  const suite = parsed as Partial<EvalSuiteManifest>;
  if (!suite.name) die(`eval suite missing name: ${suitePath}`);
  if (!suite.version) die(`eval suite missing version: ${suitePath}`);
  if (!suite.defaults) die(`eval suite missing defaults: ${suitePath}`);
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) die(`eval suite has no tasks: ${suitePath}`);
  for (const task of suite.tasks) {
    if (!task.id) die(`eval task missing id in suite ${suite.name}`);
    if (!task.prompt) die(`eval task ${task.id} missing prompt`);
    if (!task.fixture) die(`eval task ${task.id} missing fixture`);
    if (!Array.isArray(task.graders)) die(`eval task ${task.id} missing graders`);
  }
  return suite as EvalSuiteManifest;
}

export interface ValidationError {
  path: string;
  message: string;
}

export function validateEvalSuite(suitePath: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!existsSync(suitePath)) {
    errors.push({ path: 'suite', message: `file not found: ${suitePath}` });
    return errors;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(suitePath, 'utf8'));
  } catch {
    errors.push({ path: 'suite', message: `not valid JSON: ${suitePath}` });
    return errors;
  }

  const suite = parsed as Record<string, unknown>;

  if (!suite.name || typeof suite.name !== 'string') {
    errors.push({ path: 'name', message: 'missing or invalid string field "name"' });
  }
  if (!suite.version || typeof suite.version !== 'string') {
    errors.push({ path: 'version', message: 'missing or invalid string field "version"' });
  }

  if (!suite.defaults || typeof suite.defaults !== 'object') {
    errors.push({ path: 'defaults', message: 'missing or invalid field "defaults"' });
  } else {
    const d = suite.defaults as Record<string, unknown>;
    if (typeof d.wall_seconds !== 'number') {
      errors.push({ path: 'defaults.wall_seconds', message: 'missing or invalid number field "wall_seconds"' });
    }
    if (typeof d.repetitions !== 'number') {
      errors.push({ path: 'defaults.repetitions', message: 'missing or invalid number field "repetitions"' });
    }
    if (typeof d.agent !== 'string') {
      errors.push({ path: 'defaults.agent', message: 'missing or invalid string field "agent"' });
    }
  }

  if (!Array.isArray(suite.tasks)) {
    errors.push({ path: 'tasks', message: 'missing or non-array field "tasks"' });
    return errors;
  }
  if (suite.tasks.length === 0) {
    errors.push({ path: 'tasks', message: 'tasks array is empty' });
    return errors;
  }

  for (const [i, raw] of (suite.tasks as unknown[]).entries()) {
    const task = raw as Record<string, unknown>;
    const prefix = `tasks[${i}]`;

    if (!task.id || typeof task.id !== 'string') {
      errors.push({ path: `${prefix}.id`, message: 'missing or invalid string field "id"' });
    }
    if (!task.prompt || typeof task.prompt !== 'string') {
      errors.push({ path: `${prefix}.prompt`, message: 'missing or invalid string field "prompt"' });
    }
    if (!task.fixture || typeof task.fixture !== 'object') {
      errors.push({ path: `${prefix}.fixture`, message: 'missing or invalid field "fixture"' });
    }
    if (!Array.isArray(task.graders)) {
      errors.push({ path: `${prefix}.graders`, message: 'missing or non-array field "graders"' });
    }
  }

  return errors;
}

export function resolveEvalSuitePath(suiteName: string): string {
  return join(process.cwd(), 'evals', 'suites', suiteName, 'suite.json');
}

export function resolveTaskFixtureDir(suiteName: string, taskId: string): string {
  return join(process.cwd(), 'evals', 'fixtures', suiteName, taskId);
}

export function resolveTaskGraderDir(suiteName: string, taskId: string): string {
  return join(process.cwd(), 'evals', 'graders', suiteName, taskId);
}
