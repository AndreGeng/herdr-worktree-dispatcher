import type { EvalArmStats, EvalComparison, EvalGradeResult, EvalRunResult, EvalTaskComparison } from './types.js';

export function buildComparison(
  suiteName: string,
  taskResults: Array<{
    task_id: string;
    task_name: string;
    category: string;
    difficulty: string;
    critical: boolean;
    arm: string;
    results: EvalGradeResult[];
    runs: EvalRunResult[];
  }>,
): EvalComparison {
  const taskIds = [...new Set(taskResults.map((t) => t.task_id))];
  const taskComparisons: EvalTaskComparison[] = [];

  let teamWins = 0;
  let soloWins = 0;
  let ties = 0;

  for (const taskId of taskIds) {
    const entries = taskResults.filter((t) => t.task_id === taskId);
    const soloEntries = entries.filter((t) => t.arm === 'solo');
    const teamEntries = entries.filter((t) => t.arm === 'team');

    const soloStats = computeArmStats(soloEntries.flatMap((e) => e.results), soloEntries.flatMap((e) => e.runs));
    const teamStats = computeArmStats(teamEntries.flatMap((e) => e.results), teamEntries.flatMap((e) => e.runs));

    const delta = teamStats.pass_rate - soloStats.pass_rate;
    const winner = delta > 0 ? 'team' : delta < 0 ? 'solo' : 'tie';
    if (winner === 'team') teamWins++;
    else if (winner === 'solo') soloWins++;
    else ties++;

    const first = entries[0];
    taskComparisons.push({
      task_id: taskId,
      task_name: first.task_name,
      category: first.category,
      difficulty: first.difficulty,
      critical: first.critical,
      solo: soloStats,
      team: teamStats,
      delta,
      winner,
    });
  }

  const allSoloRuns = taskResults.filter((t) => t.arm === 'solo').flatMap((e) => e.runs);
  const allTeamRuns = taskResults.filter((t) => t.arm === 'team').flatMap((e) => e.runs);
  const allSoloResults = taskResults.filter((t) => t.arm === 'solo').flatMap((e) => e.results);
  const allTeamResults = taskResults.filter((t) => t.arm === 'team').flatMap((e) => e.results);

  const soloStats = computeArmStats(allSoloResults, allSoloRuns);
  const teamStats = computeArmStats(allTeamResults, allTeamRuns);

  return {
    suite_name: suiteName,
    timestamp: new Date().toISOString(),
    task_count: taskIds.length,
    repetitions: allSoloResults.length / taskIds.length || 1,
    overall: {
      solo_pass_rate: soloStats.pass_rate,
      team_pass_rate: teamStats.pass_rate,
      delta: teamStats.pass_rate - soloStats.pass_rate,
      team_wins: teamWins,
      solo_wins: soloWins,
      ties,
    },
    cost: {
      solo_median_wall_ms: soloStats.median_wall_ms,
      team_median_wall_ms: teamStats.median_wall_ms,
      wall_ratio: soloStats.median_wall_ms > 0 ? teamStats.median_wall_ms / soloStats.median_wall_ms : 0,
      solo_total_wall_ms: soloStats.mean_wall_ms * soloStats.total_count,
      team_total_wall_ms: teamStats.mean_wall_ms * teamStats.total_count,
    },
    tasks: taskComparisons,
  };
}

function computeArmStats(results: EvalGradeResult[], runs: EvalRunResult[]): EvalArmStats {
  const total = results.length;
  const passCount = results.filter((r) => r.overall === 'pass').length;
  const wallTimes = runs.filter((r) => r.wall_ms > 0).map((r) => r.wall_ms).sort((a, b) => a - b);
  const timeouts = runs.filter((r) => r.status === 'timeout').length;
  const errors = runs.filter((r) => r.status === 'error').length;

  return {
    pass_rate: total > 0 ? passCount / total : 0,
    pass_count: passCount,
    total_count: total,
    median_wall_ms: percentile(wallTimes, 50),
    p95_wall_ms: percentile(wallTimes, 95),
    mean_wall_ms: wallTimes.length > 0 ? wallTimes.reduce((a, b) => a + b, 0) / wallTimes.length : 0,
    timeout_count: timeouts,
    error_count: errors,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}
