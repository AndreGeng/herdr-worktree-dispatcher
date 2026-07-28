import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildComparison } from '../dist/eval/comparison.js';
import { buildReport } from '../dist/eval/report.js';
import { evaluateGate } from '../dist/eval/gate.js';

function makeGrade(taskId, arm, rep, passed) {
  return {
    task_id: taskId,
    arm,
    repetition: rep,
    overall: passed ? 'pass' : 'fail',
    graders: [{ label: 'test', type: 'command', passed }],
  };
}

function makeRun(taskId, arm, rep, wallMs, merged) {
  return {
    config: {
      suite_name: 'v1',
      arm,
      task_id: taskId,
      repetition: rep,
      agent: 'opencode',
      agent_args: [],
      wall_seconds: 1800,
    },
    status: merged ? 'pass' : 'fail',
    wall_ms: wallMs,
    merged,
    artifact_dir: '/tmp/test',
  };
}

test('comparison computes overall pass rates and deltas', () => {
  const results = [
    { task_id: 't1', task_name: 'Task 1', category: 'bug-fix', difficulty: 'easy', critical: false, arm: 'solo', results: [makeGrade('t1', 'solo', 1, true), makeGrade('t1', 'solo', 2, false)], runs: [makeRun('t1', 'solo', 1, 1000, true), makeRun('t1', 'solo', 2, 2000, false)] },
    { task_id: 't1', task_name: 'Task 1', category: 'bug-fix', difficulty: 'easy', critical: false, arm: 'team', results: [makeGrade('t1', 'team', 1, true), makeGrade('t1', 'team', 2, true)], runs: [makeRun('t1', 'team', 1, 1500, true), makeRun('t1', 'team', 2, 1800, true)] },
    { task_id: 't2', task_name: 'Task 2', category: 'feature', difficulty: 'medium', critical: true, arm: 'solo', results: [makeGrade('t2', 'solo', 1, false)], runs: [makeRun('t2', 'solo', 1, 3000, false)] },
    { task_id: 't2', task_name: 'Task 2', category: 'feature', difficulty: 'medium', critical: true, arm: 'team', results: [makeGrade('t2', 'team', 1, true)], runs: [makeRun('t2', 'team', 1, 2500, true)] },
  ];

  const comparison = buildComparison('v1', results);

  assert.equal(comparison.task_count, 2);
  assert.equal(comparison.overall.solo_pass_rate, 1 / 3);
  assert.equal(comparison.overall.team_pass_rate, 1.0);
  assert.ok(comparison.overall.delta > 0.6);
  assert.equal(comparison.overall.team_wins, 2);
  assert.equal(comparison.overall.solo_wins, 0);
  assert.equal(comparison.overall.ties, 0);
});

test('comparison handles ties', () => {
  const results = [
    { task_id: 't1', task_name: 'Task 1', category: 'bug-fix', difficulty: 'easy', critical: false, arm: 'solo', results: [makeGrade('t1', 'solo', 1, true)], runs: [makeRun('t1', 'solo', 1, 1000, true)] },
    { task_id: 't1', task_name: 'Task 1', category: 'bug-fix', difficulty: 'easy', critical: false, arm: 'team', results: [makeGrade('t1', 'team', 1, true)], runs: [makeRun('t1', 'team', 1, 1200, true)] },
  ];

  const comparison = buildComparison('v1', results);
  assert.equal(comparison.overall.delta, 0);
  assert.equal(comparison.overall.ties, 1);
});

test('report generates markdown with all sections', () => {
  const comparison = {
    suite_name: 'v1',
    timestamp: '2026-07-28T00:00:00.000Z',
    task_count: 2,
    repetitions: 3,
    overall: { solo_pass_rate: 0.5, team_pass_rate: 0.8, delta: 0.3, team_wins: 1, solo_wins: 0, ties: 1 },
    cost: { solo_median_wall_ms: 5000, team_median_wall_ms: 8000, wall_ratio: 1.6, solo_total_wall_ms: 15000, team_total_wall_ms: 24000 },
    tasks: [
      { task_id: 't1', task_name: 'Task 1', category: 'bug-fix', difficulty: 'easy', critical: false, solo: { pass_rate: 0.5, pass_count: 1, total_count: 2, median_wall_ms: 5000, p95_wall_ms: 5000, mean_wall_ms: 5000, timeout_count: 0, error_count: 0 }, team: { pass_rate: 1, pass_count: 2, total_count: 2, median_wall_ms: 8000, p95_wall_ms: 8000, mean_wall_ms: 8000, timeout_count: 0, error_count: 0 }, delta: 0.5, winner: 'team' },
      { task_id: 't2', task_name: 'Task 2', category: 'feature', difficulty: 'medium', critical: true, solo: { pass_rate: 0.5, pass_count: 1, total_count: 2, median_wall_ms: 5000, p95_wall_ms: 5000, mean_wall_ms: 5000, timeout_count: 0, error_count: 0 }, team: { pass_rate: 0.5, pass_count: 1, total_count: 2, median_wall_ms: 8000, p95_wall_ms: 8000, mean_wall_ms: 8000, timeout_count: 0, error_count: 0 }, delta: 0, winner: 'tie' },
    ],
  };

  const report = buildReport(comparison);
  assert.ok(report.markdown.includes('# Eval Report: v1'));
  assert.ok(report.markdown.includes('## Overall'));
  assert.ok(report.markdown.includes('## Task Details'));
  assert.ok(report.markdown.includes('**Team wins:** 1'));
  assert.ok(report.markdown.includes('50%'));
  assert.ok(report.markdown.includes('80.0%'));
});

test('gate passes when team improves or is within tolerance', () => {
  const comparison = {
    suite_name: 'v1',
    timestamp: '2026-07-28T00:00:00.000Z',
    task_count: 1,
    repetitions: 3,
    overall: { solo_pass_rate: 0.6, team_pass_rate: 0.8, delta: 0.2, team_wins: 1, solo_wins: 0, ties: 0 },
    cost: { solo_median_wall_ms: 5000, team_median_wall_ms: 8000, wall_ratio: 1.6, solo_total_wall_ms: 5000, team_total_wall_ms: 8000 },
    tasks: [],
  };

  const result = evaluateGate(comparison, { quality_margin: 0.10, max_wall_ratio: 2.0 });
  assert.equal(result.status, 'PASS');
});

test('gate fails when team regresses beyond margin', () => {
  const comparison = {
    suite_name: 'v1',
    timestamp: '2026-07-28T00:00:00.000Z',
    task_count: 1,
    repetitions: 3,
    overall: { solo_pass_rate: 0.8, team_pass_rate: 0.5, delta: -0.3, team_wins: 0, solo_wins: 1, ties: 0 },
    cost: { solo_median_wall_ms: 5000, team_median_wall_ms: 8000, wall_ratio: 1.6, solo_total_wall_ms: 5000, team_total_wall_ms: 8000 },
    tasks: [],
  };

  const result = evaluateGate(comparison, { quality_margin: 0.10 });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.reason.includes('regression'));
});

test('gate fails when wall time exceeds limit', () => {
  const comparison = {
    suite_name: 'v1',
    timestamp: '2026-07-28T00:00:00.000Z',
    task_count: 1,
    repetitions: 3,
    overall: { solo_pass_rate: 0.8, team_pass_rate: 0.9, delta: 0.1, team_wins: 1, solo_wins: 0, ties: 0 },
    cost: { solo_median_wall_ms: 5000, team_median_wall_ms: 10000, wall_ratio: 2.0, solo_total_wall_ms: 5000, team_total_wall_ms: 10000 },
    tasks: [],
  };

  const result = evaluateGate(comparison, { quality_margin: 0.10, max_wall_ratio: 1.5 });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.reason.includes('wall time'));
});

test('gate returns PASS for small regression within margin', () => {
  const comparison = {
    suite_name: 'v1',
    timestamp: '2026-07-28T00:00:00.000Z',
    task_count: 1,
    repetitions: 3,
    overall: { solo_pass_rate: 0.8, team_pass_rate: 0.75, delta: -0.05, team_wins: 0, solo_wins: 1, ties: 0 },
    cost: { solo_median_wall_ms: 5000, team_median_wall_ms: 8000, wall_ratio: 1.6, solo_total_wall_ms: 5000, team_total_wall_ms: 8000 },
    tasks: [],
  };

  const result = evaluateGate(comparison, { quality_margin: 0.10 });
  assert.equal(result.status, 'PASS');
  assert.ok(result.reason.includes('tolerance'));
});

test('gate fails on critical task regression', () => {
  const comparison = {
    suite_name: 'v1',
    timestamp: '2026-07-28T00:00:00.000Z',
    task_count: 1,
    repetitions: 3,
    overall: { solo_pass_rate: 0.7, team_pass_rate: 0.7, delta: 0, team_wins: 0, solo_wins: 0, ties: 1 },
    cost: { solo_median_wall_ms: 5000, team_median_wall_ms: 8000, wall_ratio: 1.6, solo_total_wall_ms: 5000, team_total_wall_ms: 8000 },
    tasks: [
      { task_id: 't1', task_name: 'Critical', category: 'bug-fix', difficulty: 'easy', critical: true, solo: { pass_rate: 1, pass_count: 3, total_count: 3, median_wall_ms: 5000, p95_wall_ms: 5000, mean_wall_ms: 5000, timeout_count: 0, error_count: 0 }, team: { pass_rate: 0.5, pass_count: 1, total_count: 2, median_wall_ms: 8000, p95_wall_ms: 8000, mean_wall_ms: 8000, timeout_count: 0, error_count: 0 }, delta: -0.5, winner: 'solo' },
    ],
  };

  const result = evaluateGate(comparison, { quality_margin: 0.10 });
  assert.equal(result.status, 'FAIL');
  assert.ok(result.reason.includes('critical'));
});
