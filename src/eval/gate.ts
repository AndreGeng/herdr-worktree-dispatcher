import type { EvalComparison, EvalGateResult, EvalGateStatus } from './types.js';

export function evaluateGate(
  comparison: EvalComparison,
  options: {
    quality_margin?: number;
    max_cost_ratio?: number;
    max_wall_ratio?: number;
  } = {},
): EvalGateResult {
  const M = options.quality_margin ?? 0.10;
  const maxCostRatio = options.max_cost_ratio ?? 2.0;
  const maxWallRatio = options.max_wall_ratio ?? 2.0;

  const criticalFailures = comparison.tasks.filter(
    (t) => t.critical && t.team.pass_rate < t.solo.pass_rate - M,
  );
  if (criticalFailures.length > 0) {
    return {
      status: 'FAIL',
      reason: `critical task regression: ${criticalFailures.map((t) => t.task_id).join(', ')}`,
      comparison,
    };
  }

  if (comparison.cost.wall_ratio > maxWallRatio) {
    return {
      status: 'FAIL',
      reason: `team wall time exceeds ${maxWallRatio}x solo (${comparison.cost.wall_ratio.toFixed(2)}x)`,
      comparison,
    };
  }

  if (comparison.cost.wall_ratio > maxCostRatio) {
    return {
      status: 'FAIL',
      reason: `team cost exceeds ${maxCostRatio}x solo (${comparison.cost.wall_ratio.toFixed(2)}x)`,
      comparison,
    };
  }

  const delta = comparison.overall.delta;
  if (delta < -M) {
    return {
      status: 'FAIL',
      reason: `team pass rate regression exceeds threshold (${(delta * 100).toFixed(1)}pp < -${(M * 100).toFixed(0)}pp)`,
      comparison,
    };
  }

  if (delta >= 0) {
    return {
      status: 'PASS',
      reason: `team improves pass rate by ${(delta * 100).toFixed(1)}pp`,
      comparison,
    };
  }

  if (delta > -M) {
    return {
      status: 'PASS',
      reason: `team regression within tolerance (${(delta * 100).toFixed(1)}pp > -${(M * 100).toFixed(0)}pp)`,
      comparison,
    };
  }

  return {
    status: 'INCONCLUSIVE',
    reason: 'insufficient evidence to determine regression or improvement',
    comparison,
  };
}
