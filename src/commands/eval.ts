import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Command } from 'commander';

import { die } from '../utils/errors.js';
import { buildComparison } from '../eval/comparison.js';
import { evalRunDir, ensureEvalDirs } from '../eval/collector.js';
import { evaluateGate } from '../eval/gate.js';
import { buildReport } from '../eval/report.js';
import { analyzeQuality } from '../eval/quality.js';
import type { EvalGradeResult, EvalRunConfig, EvalRunResult, EvalArm, EvalTask, EvalGraderDef } from '../eval/types.js';
import { loadEvalSuite, resolveEvalSuitePath, validateEvalSuite } from '../eval/suite.js';

interface EvalRunOptions {
  suite?: string;
  tasks?: string[];
  arms?: string;
  repetitions?: string;
  wall?: string;
  agent?: string;
  agentArg?: string[];
  teamProfile?: string;
  teamAgentArg?: string[];
  task?: string[];
}

interface EvalGradeOptions {
  suite?: string;
  run?: string;
}

interface EvalCompareOptions {
  suite?: string;
  run?: string;
}

interface EvalGateOptions {
  suite?: string;
  run?: string;
  qualityMargin?: string;
}

interface EvalValidateOptions {
  suite?: string;
}

export function registerEval(program: Command): void {
  const evalCmd = program
    .command('eval')
    .description('Automated evaluation harness for comparing solo vs team modes');

  evalCmd
    .command('run')
    .description('Run evaluation tasks in solo and/or team arms')
    .option('-s, --suite <name>', 'Eval suite name', 'v1')
    .option('-t, --task <id>', 'Run specific task (repeatable)', collect, [])
    .option('--tasks <ids>', 'Comma-separated task IDs')
    .option('--arms <arms>', 'Comma-separated arms to run (solo,team)', 'solo,team')
    .option('-r, --repetitions <n>', 'Number of repetitions per task', '3')
    .option('-w, --wall <seconds>', 'Per-task wall timeout in seconds', '1800')
    .option('-a, --agent <command>', 'Agent command for solo mode')
    .option('--agent-arg <arg>', 'Extra agent args for solo mode (repeatable)', collect, [])
    .option('--team-profile <name>', 'Team profile for team mode')
    .option('--team-agent-arg <arg>', 'Extra agent args for team mode (repeatable)', collect, [])
    .action((options: EvalRunOptions) => runEval(options));

  evalCmd
    .command('grade')
    .description('Grade completed eval run results')
    .option('-s, --suite <name>', 'Eval suite name', 'v1')
    .option('-r, --run <id>', 'Eval run ID')
    .action((options: EvalGradeOptions) => runGrade(options));

  evalCmd
    .command('compare')
    .description('Compare solo vs team results')
    .option('-s, --suite <name>', 'Eval suite name', 'v1')
    .option('-r, --run <id>', 'Eval run ID')
    .action((options: EvalCompareOptions) => runCompare(options));

  evalCmd
    .command('gate')
    .description('Evaluate regression gate against baseline')
    .option('-s, --suite <name>', 'Eval suite name', 'v1')
    .option('-r, --run <id>', 'Eval run ID')
    .option('--quality-margin <pp>', 'Quality regression margin', '10')
    .action((options: EvalGateOptions) => runGate(options));

  evalCmd
    .command('report')
    .description('Generate markdown report from comparison')
    .option('-s, --suite <name>', 'Eval suite name', 'v1')
    .option('-r, --run <id>', 'Eval run ID')
    .action((options: EvalCompareOptions) => runReport(options));

  evalCmd
    .command('validate')
    .description('Validate that a suite file is well-formed')
    .option('-s, --suite <name>', 'Eval suite name', 'v1')
    .action((options: EvalValidateOptions) => runValidate(options));
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function runEval(options: EvalRunOptions): void {
  const suiteName = options.suite || 'v1';
  const suitePath = resolveEvalSuitePath(suiteName);
  const suite = loadEvalSuite(suitePath);
  const arms = (options.arms || 'solo,team').split(',').map((a) => a.trim()) as EvalArm[];
  const repetitions = parseInt(String(options.repetitions || '3'), 10);
  const wallSeconds = parseInt(String(options.wall || '1800'), 10);

  const selectedTasks = options.tasks?.length
    ? options.tasks
    : options.task?.length
      ? options.task
      : undefined;

  const tasks = selectedTasks
    ? suite.tasks.filter((t) => selectedTasks.includes(t.id))
    : suite.tasks;

  if (tasks.length === 0) die('no matching tasks found in suite');

  const evalRunId = `eval_${Date.now().toString(36)}`;
  const baseDir = join(process.cwd(), '.herdr-eval', 'runs');
  ensureEvalDirs(baseDir, evalRunId);

  process.stdout.write(JSON.stringify({ eval_run_id: evalRunId, suite_name: suiteName, tasks: tasks.length, arms, repetitions }) + '\n');

  for (const arm of arms) {
    for (const task of tasks) {
      for (let rep = 1; rep <= repetitions; rep++) {
        const wall = task.limits?.wall_seconds || wallSeconds;
        const agent = arm === 'team' ? (options.agent || suite.defaults.team_leader_agent || suite.defaults.agent) : (options.agent || suite.defaults.agent);
        const agentArgs = arm === 'team' ? (options.teamAgentArg || suite.defaults.team_leader_args || suite.defaults.team_agent_args || []) : (options.agentArg || suite.defaults.agent_args || []);
        const teamProfile = arm === 'team' ? (options.teamProfile || suite.defaults.team_profile) : undefined;
        const teamLeaderAgent = arm === 'team' ? (suite.defaults.team_leader_agent || agent) : undefined;
        const teamLeaderArgs = arm === 'team' ? (suite.defaults.team_leader_args || []) : undefined;
        const teamWorkerAgent = arm === 'team' ? (suite.defaults.team_worker_agent || 'codex') : undefined;
        const teamWorkerArgs = arm === 'team' ? (suite.defaults.team_worker_args || []) : undefined;

        const config: EvalRunConfig = {
          suite_name: suiteName,
          arm,
          task_id: task.id,
          repetition: rep,
          base_commit: task.fixture.commit,
          source_url: task.fixture.url,
          agent,
          agent_args: agentArgs,
          team_profile: teamProfile,
          team_leader_agent: teamLeaderAgent,
          team_leader_args: teamLeaderArgs,
          team_worker_agent: teamWorkerAgent,
          team_worker_args: teamWorkerArgs,
          team_agent_args: options.teamAgentArg || suite.defaults.team_agent_args || [],
          wall_seconds: wall,
        };

        const artifactDir = evalRunDir(baseDir, evalRunId, arm, task.id, rep);
        mkdirSync(artifactDir, { recursive: true });

        const result = executeTask(task as EvalTask, config, artifactDir);
        writeFileSync(join(artifactDir, 'run.json'), JSON.stringify(result, null, 2) + '\n');

        process.stdout.write(`  ${arm}/${task.id}/rep-${rep}: ${result.status} (${Math.round(result.wall_ms / 1000)}s)\n`);
      }
    }
  }

  process.stdout.write(`\nEval run complete: ${evalRunId}\n`);
  process.stdout.write(`Artifacts: ${baseDir}/${evalRunId}\n`);
  process.stdout.write(`Next: herdr-worktree-dispatcher eval grade --run ${evalRunId}\n`);
}

function executeTask(task: EvalTask, config: EvalRunConfig, artifactDir: string): EvalRunResult {
  const cloneDir = join(artifactDir, 'clone');
  const startTime = Date.now();

  try {
    if (config.source_url) {
      execFileSync('git', ['clone', '--quiet', config.source_url, cloneDir], {
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (config.base_commit) {
        execFileSync('git', ['checkout', '--quiet', config.base_commit], {
          cwd: cloneDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } else {
      const srcCwd = process.cwd();
      execFileSync('git', ['clone', '--quiet', srcCwd, cloneDir], {
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (config.base_commit) {
        execFileSync('git', ['checkout', '--quiet', config.base_commit], {
          cwd: cloneDir,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    }

    execFileSync('git', ['checkout', '-b', 'eval-work'], {
      cwd: cloneDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const promptPath = join(artifactDir, 'PROMPT.md');
    writeFileSync(promptPath, buildEvalPrompt(task));
    writeFileSync(join(artifactDir, 'task.json'), JSON.stringify(task, null, 2));

    if (config.arm === 'solo') {
      return executeSolo(config, cloneDir, promptPath, artifactDir, startTime);
    } else {
      return executeTeam(config, cloneDir, promptPath, artifactDir, startTime);
    }
  } catch (error: unknown) {
    const wallMs = Date.now() - startTime;
    const err = error as { message?: string };
    return {
      config,
      status: 'error',
      wall_ms: wallMs,
      merged: false,
      error: err.message || String(error),
      artifact_dir: artifactDir,
    };
  }
}

function executeSolo(
  config: EvalRunConfig,
  cloneDir: string,
  promptPath: string,
  artifactDir: string,
  startTime: number,
): EvalRunResult {
  const agentCmd = config.agent;
  const agentArgs = config.agent_args || [];
  const wallMs = config.wall_seconds * 1000;

  try {
    const promptContent = readFileSync(promptPath, 'utf8');
    const args = buildAgentArgs(agentCmd, agentArgs, promptContent, promptPath, config.wall_seconds);
    execFileSync(args.command, args.args, {
      cwd: cloneDir,
      timeout: wallMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@test', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@test' },
    });
  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= wallMs - 1000) {
      return { config, status: 'timeout', wall_ms: elapsed, merged: false, error: 'agent timed out', artifact_dir: artifactDir };
    }
    const err = error as { status?: number; stderr?: string };
    if (err.status !== undefined && err.status !== 0) {
      return { config, status: 'error', wall_ms: elapsed, merged: false, error: `agent exited with code ${err.status}: ${(err.stderr || '').slice(0, 500)}`, artifact_dir: artifactDir };
    }
  }

  return finalizeRun(config, cloneDir, artifactDir, startTime);
}

function executeTeam(
  config: EvalRunConfig,
  cloneDir: string,
  promptPath: string,
  artifactDir: string,
  startTime: number,
): EvalRunResult {
  const wallMs = config.wall_seconds * 1000;

  try {
    const task = JSON.parse(readFileSync(join(artifactDir, 'task.json'), 'utf8')) as EvalTask;
    const teamPrompt = buildTeamEvalPrompt(task, config);
    const teamPromptPath = join(artifactDir, 'TEAM_PROMPT.md');
    writeFileSync(teamPromptPath, teamPrompt);

    const leaderCmd = config.team_leader_agent || config.agent;
    const leaderArgs = config.team_leader_args || [];

    const args = buildAgentArgs(leaderCmd, leaderArgs, teamPrompt, teamPromptPath, config.wall_seconds);
    execFileSync(args.command, args.args, {
      cwd: cloneDir,
      timeout: wallMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EVAL_WORKER_AGENT: config.team_worker_agent || 'codex',
        GIT_AUTHOR_NAME: 'eval',
        GIT_AUTHOR_EMAIL: 'eval@test',
        GIT_COMMITTER_NAME: 'eval',
        GIT_COMMITTER_EMAIL: 'eval@test',
      },
    });
  } catch (error: unknown) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= wallMs - 1000) {
      return { config, status: 'timeout', wall_ms: elapsed, merged: false, error: 'team timed out', artifact_dir: artifactDir };
    }
    const err = error as { status?: number; stderr?: string };
    if (err.status !== undefined && err.status !== 0) {
      return { config, status: 'error', wall_ms: elapsed, merged: false, error: `team exited with code ${err.status}: ${(err.stderr || '').slice(0, 500)}`, artifact_dir: artifactDir };
    }
  }

  return finalizeRun(config, cloneDir, artifactDir, startTime);
}

function finalizeRun(
  config: EvalRunConfig,
  cloneDir: string,
  artifactDir: string,
  startTime: number,
): EvalRunResult {
  const wallMs = Date.now() - startTime;

  let merged = false;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: cloneDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const hasUncommittedChanges = status.trim().length > 0;

    let hasCommittedChanges = false;
    try {
      const diffOutput = execFileSync('git', ['diff', 'HEAD~1', 'HEAD', '--stat'], {
        cwd: cloneDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      hasCommittedChanges = diffOutput.trim().length > 0;
    } catch {
      hasCommittedChanges = false;
    }

    if (hasUncommittedChanges) {
      try {
        execFileSync('git', ['add', '-A'], { cwd: cloneDir, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['commit', '-m', 'eval: automated task completion'], {
          cwd: cloneDir,
          env: { ...process.env, GIT_AUTHOR_NAME: 'eval', GIT_AUTHOR_EMAIL: 'eval@test', GIT_COMMITTER_NAME: 'eval', GIT_COMMITTER_EMAIL: 'eval@test' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        merged = true;
      } catch {
        merged = false;
      }
    } else if (hasCommittedChanges) {
      merged = true;
    }
  } catch {
    merged = false;
  }

  const patchPath = join(artifactDir, 'patch.diff');
  try {
    const patch = execFileSync('git', ['diff', 'HEAD~1', 'HEAD'], {
      cwd: cloneDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    writeFileSync(patchPath, patch);
  } catch {
    writeFileSync(patchPath, '');
  }

  return {
    config,
    status: merged ? 'pass' : 'fail',
    wall_ms: wallMs,
    merged,
    patch_path: merged ? patchPath : undefined,
    artifact_dir: artifactDir,
  };
}

function buildAgentArgs(agentCmd: string, extraArgs: string[], prompt: string, promptFile?: string, wallSeconds?: number): { command: string; args: string[] } {
  const tokens = agentCmd.trim().split(/\s+/);
  const command = tokens[0];
  const baseArgs = tokens.slice(1);
  const timeoutSecs = Math.max((wallSeconds || 120) + 30, 180);

  if (command === 'opencode') {
    const promptPath = promptFile ? `'${promptFile}'` : '/dev/stdin';
    const hasModel = extraArgs.includes('-m') || extraArgs.some(a => a.startsWith('--model'));
    const modelArgs = hasModel ? [] : ['-m', 'opencode/mimo-v2.5-free'];
    const opencodeArgs = [...baseArgs, 'run', '--format', 'default', '--dangerously-skip-permissions', ...modelArgs, `$(cat ${promptPath})`, ...extraArgs];
    return { command: 'timeout', args: [String(timeoutSecs), 'opencode', ...opencodeArgs] };
  }
  if (command === 'claude') {
    const claudeArgs = [...baseArgs, '-p', prompt, '--output-format', 'text', '--no-session-persistence', '--dangerously-skip-permissions', ...extraArgs];
    return { command: 'timeout', args: [String(timeoutSecs), 'claude', ...claudeArgs] };
  }
  if (command === 'codex') {
    return { command, args: [...baseArgs, 'exec', '--dangerously-bypass-approvals-and-sandbox', prompt, ...extraArgs] };
  }
  if (command === 'pi') {
    return { command, args: [...baseArgs, '-p', '--mode', 'json', prompt, ...extraArgs] };
  }

  return { command, args: [...baseArgs, prompt, ...extraArgs] };
}

function buildEvalPrompt(task: EvalTask): string {
  let prompt = `You are running in an evaluation worktree. Implement the task below directly in this checkout.
Verify your changes before finishing.
Do not create additional worktrees or use external orchestration tools.

Task:
${task.prompt}
`;
  if (task.acceptance?.length) {
    prompt += `\nAcceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}\n`;
  }
  return prompt;
}

function buildTeamEvalPrompt(task: EvalTask, config: EvalRunConfig): string {
  let prompt = `You are the leader agent in a team evaluation. Your role is to complete the task with high quality.

Task:
${task.prompt}
`;
  if (task.acceptance?.length) {
    prompt += `\nAcceptance criteria:\n${task.acceptance.map((a) => `- ${a}`).join('\n')}\n`;
  }
  prompt += `\nComplete this task directly. Focus on quality, correctness, and writing tests.
When done, you MUST commit your changes by running these commands:

git add -A
git commit -m "feat: complete task"

Do not skip the commit step. Do not wait for user input. Just run the commands above.\n`;
  return prompt;
}

function runGrade(options: EvalGradeOptions): void {
  const suiteName = options.suite || 'v1';
  const evalRunId = options.run;
  if (!evalRunId) die('grade requires --run <id>');

  const baseDir = join(process.cwd(), '.herdr-eval', 'runs');
  const runDir = join(baseDir, evalRunId);
  if (!existsSync(runDir)) die(`eval run not found: ${evalRunId}`);

  const suitePath = resolveEvalSuitePath(suiteName);
  const suite = loadEvalSuite(suitePath);

  const arms = ['solo', 'team'] as const;
  let graded = 0;

  for (const arm of arms) {
    for (const task of suite.tasks) {
      for (let rep = 1; rep <= suite.defaults.repetitions; rep++) {
        const dir = evalRunDir(baseDir, evalRunId, arm, task.id, rep);
        const runJsonPath = join(dir, 'run.json');
        if (!existsSync(runJsonPath)) continue;

        const runResult: EvalRunResult = JSON.parse(readFileSync(runJsonPath, 'utf8'));
        if (runResult.status !== 'pass' && runResult.status !== 'fail') continue;

        const gradeResult: EvalGradeResult = {
          task_id: task.id,
          arm,
          repetition: rep,
          overall: runResult.merged ? 'pass' : 'fail',
          graders: [],
        };

        if (runResult.merged && task.graders.length > 0) {
          const cloneDir = join(dir, 'clone');
          if (existsSync(cloneDir)) {
            for (const grader of task.graders) {
              if (grader.type === 'command') {
                try {
                  execFileSync('sh', ['-c', grader.command], {
                    cwd: cloneDir,
                    encoding: 'utf8',
                    timeout: 120_000,
                    stdio: ['pipe', 'pipe', 'pipe'],
                  });
                  gradeResult.graders.push({ label: grader.label || grader.command, type: grader.type, passed: true });
                } catch (error: unknown) {
                  const err = error as { stderr?: string };
                  gradeResult.graders.push({ label: grader.label || grader.command, type: grader.type, passed: false, error: (err.stderr || '').slice(0, 500) });
                }
              } else if (grader.type === 'file-exists') {
                const filePath = join(cloneDir, grader.path);
                gradeResult.graders.push({ label: grader.label || `file: ${grader.path}`, type: grader.type, passed: existsSync(filePath) });
              }
            }
          }
        }

        gradeResult.overall = gradeResult.graders.some((g) => !g.passed) ? 'fail' : runResult.merged ? 'pass' : 'fail';

        if (runResult.merged) {
          const cloneDir = join(dir, 'clone');
          if (existsSync(cloneDir)) {
            try {
              gradeResult.quality = analyzeQuality(cloneDir, task);
            } catch {
              // quality analysis failed, skip
            }
          }
        }

        writeFileSync(join(dir, 'grade.json'), JSON.stringify(gradeResult, null, 2) + '\n');
        graded++;
      }
    }
  }

  process.stdout.write(`Graded ${graded} results\n`);
  process.stdout.write(`Next: herdr-worktree-dispatcher eval compare --run ${evalRunId}\n`);
}

function runCompare(options: EvalCompareOptions): void {
  const suiteName = options.suite || 'v1';
  const evalRunId = options.run;
  if (!evalRunId) die('compare requires --run <id>');

  const baseDir = join(process.cwd(), '.herdr-eval', 'runs');
  const runDir = join(baseDir, evalRunId);
  if (!existsSync(runDir)) die(`eval run not found: ${evalRunId}`);

  const suitePath = resolveEvalSuitePath(suiteName);
  const suite = loadEvalSuite(suitePath);

  const taskResults: Array<{
    task_id: string;
    task_name: string;
    category: string;
    difficulty: string;
    critical: boolean;
    arm: string;
    results: EvalGradeResult[];
    runs: EvalRunResult[];
  }> = [];

  for (const task of suite.tasks) {
    for (const arm of ['solo', 'team'] as const) {
      const results: EvalGradeResult[] = [];
      const runs: EvalRunResult[] = [];

      for (let rep = 1; rep <= suite.defaults.repetitions; rep++) {
        const dir = evalRunDir(baseDir, evalRunId, arm, task.id, rep);
        const runJsonPath = join(dir, 'run.json');
        const gradeJsonPath = join(dir, 'grade.json');

        if (existsSync(runJsonPath)) {
          runs.push(JSON.parse(readFileSync(runJsonPath, 'utf8')));
        }
        if (existsSync(gradeJsonPath)) {
          results.push(JSON.parse(readFileSync(gradeJsonPath, 'utf8')));
        }
      }

      if (results.length > 0 || runs.length > 0) {
        taskResults.push({
          task_id: task.id,
          task_name: task.name,
          category: task.category,
          difficulty: task.difficulty,
          critical: task.critical || false,
          arm,
          results,
          runs,
        });
      }
    }
  }

  const comparison = buildComparison(suiteName, taskResults);
  const comparisonPath = join(runDir, 'comparison.json');
  writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2) + '\n');
  process.stdout.write(JSON.stringify(comparison, null, 2) + '\n');
  process.stdout.write(`\nNext: herdr-worktree-dispatcher eval report --run ${evalRunId}\n`);
}

function runGate(options: EvalGateOptions): void {
  const evalRunId = options.run;
  if (!evalRunId) die('gate requires --run <id>');

  const baseDir = join(process.cwd(), '.herdr-eval', 'runs');
  const comparisonPath = join(baseDir, evalRunId, 'comparison.json');
  if (!existsSync(comparisonPath)) die(`comparison not found for run ${evalRunId}. Run 'eval compare' first.`);

  const comparison = JSON.parse(readFileSync(comparisonPath, 'utf8'));
  const margin = parseFloat(options.qualityMargin || '10') / 100;

  const result = evaluateGate(comparison, { quality_margin: margin });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (result.status === 'FAIL') {
    process.exit(1);
  }
}

function runReport(options: EvalCompareOptions): void {
  const evalRunId = options.run;
  if (!evalRunId) die('report requires --run <id>');

  const baseDir = join(process.cwd(), '.herdr-eval', 'runs');
  const comparisonPath = join(baseDir, evalRunId, 'comparison.json');
  if (!existsSync(comparisonPath)) die(`comparison not found for run ${evalRunId}. Run 'eval compare' first.`);

  const comparison = JSON.parse(readFileSync(comparisonPath, 'utf8'));

  const qualityData = new Map<string, { solo?: EvalGradeResult; team?: EvalGradeResult }>();
  const suitePath = resolveEvalSuitePath(comparison.suite_name);
  const suite = loadEvalSuite(suitePath);

  for (const task of suite.tasks) {
    const taskData: { solo?: EvalGradeResult; team?: EvalGradeResult } = {};

    const soloGradePath = join(baseDir, evalRunId, 'solo', task.id, 'rep-1', 'grade.json');
    if (existsSync(soloGradePath)) {
      taskData.solo = JSON.parse(readFileSync(soloGradePath, 'utf8'));
    }

    const teamGradePath = join(baseDir, evalRunId, 'team', task.id, 'rep-1', 'grade.json');
    if (existsSync(teamGradePath)) {
      taskData.team = JSON.parse(readFileSync(teamGradePath, 'utf8'));
    }

    qualityData.set(task.id, taskData);
  }

  const report = buildReport(comparison, qualityData);
  const reportPath = join(baseDir, evalRunId, 'report.md');
  writeFileSync(reportPath, report.markdown);
  process.stdout.write(report.markdown + '\n');
  process.stdout.write(`\nReport saved: ${reportPath}\n`);
}

function runValidate(options: EvalValidateOptions): void {
  const suiteName = options.suite || 'v1';
  const suitePath = resolveEvalSuitePath(suiteName);
  const errors = validateEvalSuite(suitePath);

  if (errors.length === 0) {
    process.stdout.write(`Suite "${suiteName}" is valid.\n`);
    return;
  }

  process.stderr.write(`Suite "${suiteName}" has ${errors.length} validation error(s):\n\n`);
  for (const err of errors) {
    process.stderr.write(`  - [${err.path}] ${err.message}\n`);
  }
  process.exit(1);
}
