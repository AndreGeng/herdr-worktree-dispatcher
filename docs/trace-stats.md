# Spec: Worker Trace Stats

## Objective
Track tool execution time for dispatched workers and aggregate it by single agent or future agent team. Users can inspect the latest run or a merge token without knowing the underlying agent session format.

## Commands
- Build: `npm run build`
- Type check: `npm run check`
- Test: `npm test`
- View token stats: `herdr-worktree-dispatcher stats --token <path>`
- View latest stats: `herdr-worktree-dispatcher stats --latest`

## Data Model
- `run_id`: one user task execution.
- `team_id`: optional team grouping for leader/worker collaboration.
- `agent_run_id`: one agent execution inside a run.
- `parent_agent_run_id`: set when a leader spawns a worker.
- `agent_role`: `solo`, `leader`, or `worker`.

Trace files live outside worktrees under `${TMPDIR}/herdr-worktree-dispatcher-traces/runs/<run_id>/agents/<agent_run_id>.jsonl` so cleanup does not delete them.

## Strategy
Hooks are the primary source when configured. Session files are the fallback source. Stats merges both sources and de-duplicates by tool call id.

## Success Criteria
- `stats --token <path>` prints worker/team summary from token metadata.
- `stats --latest` prints the most recent dispatch summary.
- Pi, Codex, Claude, and OpenCode have fallback parsers.
- A generic hook ingestion command can append tool lifecycle events to trace JSONL.
- Team fields exist in every new trace identity so future leader/worker dispatch can aggregate without schema changes.
