import type { EvalComparison, EvalReport, EvalGradeResult } from './types.js';

export function buildReport(comparison: EvalComparison, qualityData?: Map<string, { solo?: EvalGradeResult; team?: EvalGradeResult }>): EvalReport {
  const lines: string[] = [];

  lines.push(`# Eval Report: ${comparison.suite_name}`);
  lines.push('');
  lines.push(`**Timestamp:** ${comparison.timestamp}`);
  lines.push(`**Tasks:** ${comparison.task_count} | **Repetitions:** ${comparison.repetitions}`);
  lines.push('');

  lines.push('## Overall');
  lines.push('');
  lines.push(`| Metric | Solo | Team | Delta |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| Pass rate | ${(comparison.overall.solo_pass_rate * 100).toFixed(1)}% | ${(comparison.overall.team_pass_rate * 100).toFixed(1)}% | ${(comparison.overall.delta >= 0 ? '+' : '')}${(comparison.overall.delta * 100).toFixed(1)}pp |`);
  lines.push(`| Median wall | ${formatMs(comparison.cost.solo_median_wall_ms)} | ${formatMs(comparison.cost.team_median_wall_ms)} | ${comparison.cost.wall_ratio.toFixed(2)}x |`);
  lines.push(`| Total wall | ${formatMs(comparison.cost.solo_total_wall_ms)} | ${formatMs(comparison.cost.team_total_wall_ms)} | |`);
  lines.push('');

  if (qualityData) {
    const soloScores: number[] = [];
    const teamScores: number[] = [];
    const soloLines: number[] = [];
    const teamLines: number[] = [];
    const soloTests: number[] = [];
    const teamTests: number[] = [];

    for (const [, data] of qualityData) {
      if (data.solo?.quality) {
        soloScores.push(data.solo.quality.quality_score);
        soloLines.push(data.solo.quality.lines_added);
        soloTests.push(data.solo.quality.test_lines_added);
      }
      if (data.team?.quality) {
        teamScores.push(data.team.quality.quality_score);
        teamLines.push(data.team.quality.lines_added);
        teamTests.push(data.team.quality.test_lines_added);
      }
    }

    const avgSoloScore = soloScores.length > 0 ? soloScores.reduce((a, b) => a + b, 0) / soloScores.length : 0;
    const avgTeamScore = teamScores.length > 0 ? teamScores.reduce((a, b) => a + b, 0) / teamScores.length : 0;
    const avgSoloLines = soloLines.length > 0 ? soloLines.reduce((a, b) => a + b, 0) / soloLines.length : 0;
    const avgTeamLines = teamLines.length > 0 ? teamLines.reduce((a, b) => a + b, 0) / teamLines.length : 0;
    const avgSoloTests = soloTests.length > 0 ? soloTests.reduce((a, b) => a + b, 0) / soloTests.length : 0;
    const avgTeamTests = teamTests.length > 0 ? teamTests.reduce((a, b) => a + b, 0) / teamTests.length : 0;

    lines.push('## Quality Metrics');
    lines.push('');
    lines.push(`| Metric | Solo | Team |`);
    lines.push(`|---|---:|---:|`);
    lines.push(`| Avg quality score | ${avgSoloScore.toFixed(1)} | ${avgTeamScore.toFixed(1)} |`);
    lines.push(`| Avg lines added | ${avgSoloLines.toFixed(0)} | ${avgTeamLines.toFixed(0)} |`);
    lines.push(`| Avg test lines | ${avgSoloTests.toFixed(0)} | ${avgTeamTests.toFixed(0)} |`);
    lines.push('');
  }

  lines.push(`**Team wins:** ${comparison.overall.team_wins} | **Solo wins:** ${comparison.overall.solo_wins} | **Ties:** ${comparison.overall.ties}`);
  lines.push('');

  lines.push('## Task Details');
  lines.push('');
  lines.push(`| Task | Category | Difficulty | Solo | Team | Delta | Winner |`);
  lines.push(`|---|---|---|---:|---:|---:|---|`);
  for (const task of comparison.tasks) {
    const solo = `${(task.solo.pass_rate * 100).toFixed(0)}%`;
    const team = `${(task.team.pass_rate * 100).toFixed(0)}%`;
    const delta = task.delta >= 0 ? `+${(task.delta * 100).toFixed(0)}pp` : `${(task.delta * 100).toFixed(0)}pp`;
    lines.push(`| ${task.task_name} | ${task.category} | ${task.difficulty} | ${solo} | ${team} | ${delta} | ${task.winner} |`);
  }
  lines.push('');

  if (qualityData) {
    lines.push('## Quality by Task');
    lines.push('');
    lines.push(`| Task | Solo Score | Team Score | Solo Lines | Team Lines | Solo Tests | Team Tests |`);
    lines.push(`|---|---:|---:|---:|---:|---:|---:|`);
    for (const [taskId, data] of qualityData) {
      const soloScore = data.solo?.quality?.quality_score ?? '-';
      const teamScore = data.team?.quality?.quality_score ?? '-';
      const soloLines = data.solo?.quality?.lines_added ?? '-';
      const teamLines = data.team?.quality?.lines_added ?? '-';
      const soloTests = data.solo?.quality?.test_lines_added ?? '-';
      const teamTests = data.team?.quality?.test_lines_added ?? '-';
      lines.push(`| ${taskId} | ${soloScore} | ${teamScore} | ${soloLines} | ${teamLines} | ${soloTests} | ${teamTests} |`);
    }
    lines.push('');
  }

  return { comparison, markdown: lines.join('\n') };
}

function formatMs(ms: number): string {
  if (ms === 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m ${remainSeconds}s`;
}
