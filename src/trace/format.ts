import type { ToolCallRecord, TraceStatsSummary } from './types.js';

export function inputPreview(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === 'string') return truncate(input.replace(/\s+/g, ' ').trim());
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'path', 'filePath', 'cmd', 'query', 'url']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return truncate(value.replace(/\s+/g, ' ').trim());
    }
    return truncate(JSON.stringify(input));
  }
  return truncate(String(input));
}

export function formatStats(summary: TraceStatsSummary): string {
  const lines: string[] = [];
  lines.push(`Run: ${summary.run_id}`);
  if (summary.team_id) lines.push(`Team: ${summary.team_id}`);
  lines.push(`Agents: ${summary.agents.length}`);
  if (summary.wall_duration_ms !== undefined) lines.push(`Wall time: ${formatDuration(summary.wall_duration_ms)}`);
  lines.push(`Tool time: ${formatDuration(summary.total_tool_duration_ms)}`);
  lines.push(`Tools: ${summary.total_tool_calls} calls, ${summary.total_failed_calls} failures`);
  if (summary.session_paths.length > 0) lines.push(`Sessions: ${summary.session_paths.join(', ')}`);
  lines.push('');
  lines.push('By Agent:');
  for (const agent of summary.agents) {
    const role = agent.agent_role === 'worker' && agent.worker_role ? `worker/${agent.worker_role}` : agent.agent_role;
    lines.push(`  ${role.padEnd(18)} ${agent.agent_kind.padEnd(8)} ${agent.agent_name.padEnd(24)} ${String(agent.tool_calls).padStart(3)} calls  ${formatDuration(agent.tool_duration_ms)}  failures ${agent.failed_calls}`);
  }
  if (summary.by_role_runtime.length > 0) {
    lines.push('');
    lines.push('By Role/Runtime:');
    for (const item of summary.by_role_runtime) {
      const label = `${item.role}(${item.agent_kind})`;
      lines.push(`  ${label.padEnd(24)} ${String(item.agents).padStart(2)} agents  ${String(item.calls).padStart(3)} calls  ${formatDuration(item.duration_ms)}  failures ${item.failed_calls}`);
    }
  }
  if (summary.by_tool.length > 0) {
    lines.push('');
    lines.push('By Tool:');
    for (const tool of summary.by_tool) {
      lines.push(`  ${tool.tool_name.padEnd(16)} ${String(tool.calls).padStart(3)} calls  ${formatDuration(tool.duration_ms)}  failures ${tool.failed_calls}`);
    }
  }
  if (summary.slowest.length > 0) {
    lines.push('');
    lines.push('Slowest:');
    summary.slowest.forEach((call: ToolCallRecord, index: number) => {
      const prefix = `${index + 1}.`.padStart(4);
      const preview = call.input_preview ? `  ${call.input_preview}` : '';
      lines.push(`${prefix} ${call.agent_kind}/${call.agent_name} ${call.tool_name} ${formatDuration(call.duration_ms ?? 0)}${call.is_error ? ' failed' : ''}${preview}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function truncate(value: string, max = 140): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
