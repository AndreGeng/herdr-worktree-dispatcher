# Herdr Worktree Dispatcher

Standalone Herdr plugin that dispatches coding tasks into temporary git worktrees and starts an agent in the new checkout. The public entrypoint remains `scripts/dispatch.sh`; the implementation is TypeScript compiled to `dist/cli.js` for npm packages.

## What It Does

- Creates a Herdr-managed git worktree under the current workspace with `add`.
- Starts an agent in the new worktree workspace.
- Builds a persistent task prompt file and starts the agent with that file.
- Requires every dispatched task to produce a file artifact, including analysis and review reports.
- Splits independent multi-task requests across multiple workers where possible.
- Finalizes implementation tasks with `merge --token`, which verifies clean checkouts, integrates the branch, and removes the temporary worktree.
- Ships with an optional coding-agent skill in `skills/worktree-dispatcher/`, including `SKILL.md` and a skill-local `scripts/dispatch.sh` wrapper.
- Imports external task collections through built-in, read-only connectors and turns them into reviewable, verified worker batches.

## Built-in Connectors and Task Batches

The dispatcher has a first-class connector boundary between external task systems and worktree execution. Connectors inspect and normalize source data; the batch layer owns human review, confirmation, verification, runtime capability checks, waves, and dispatch.

The first built-in connector is `feishu-base`. It calls the authenticated `feishu` CLI and never writes back to Base.

```bash
# Discover/check built-in connectors
scripts/dispatch.sh connector list
scripts/dispatch.sh connector check feishu-base

# Inspect only: no record selection, attachment download, worktree, or worker
scripts/dispatch.sh source inspect \
  'https://tenant.feishu.cn/base/APP?table=TABLE&view=VIEW'
```

`source inspect` creates a retained batch under:

```text
<source-repo>/.herdr-worktree-dispatcher/batches/<batch-id>/
```

and returns a `REVIEW.md` path. If the user did not provide criteria, the dispatcher must stop for scope confirmation. A Base URL or view never implicitly authorizes every visible record.

Prepare exactly one confirmed selection:

```bash
scripts/dispatch.sh source prepare --batch <batch> --criteria criteria.json

# Only after the user explicitly confirms every visible record:
scripts/dispatch.sh source prepare --batch <batch> --all-visible-records
```

Preparation downloads only selected attachments, enforces a 100 MiB per-file and 500 MiB per-batch default limit, records hashes, and renders:

```text
REVIEW.md
tasks/*.md
assets/
.internal/*.json
```

`REVIEW.md` and `tasks/*.md` are the human review surface. `.internal` is the machine-readable state and recovery protocol. Image prompts contain `ATTACHMENT_OBSERVATION_REQUIRED` until a vision-capable caller actually inspects and documents each image; verification refuses unresolved placeholders.

Before dispatch:

```bash
scripts/dispatch.sh source refresh --batch <batch>
scripts/dispatch.sh batch verify --batch <batch>
scripts/dispatch.sh batch preview --batch <batch> [--profile NAME]
```

`batch preview` writes `DISPATCH.md` and returns a digest covering the selection, prompts, attachments, task relationships, runtime, and profile. Any relevant change invalidates the digest.

After one final user confirmation:

```bash
scripts/dispatch.sh batch dispatch \
  --batch <batch> \
  --confirm <preview-digest> \
  [--profile NAME]
```

Only the earliest ready wave is started. Independent tasks in that wave receive separate worktrees and lifecycle tokens. Tasks with unmerged dependencies remain blocked. Codex image tasks receive each image via `-i`; image-bearing tasks on runtimes without a verified image-input path are blocked rather than silently losing context.

Other batch commands:

```bash
scripts/dispatch.sh batch review --batch <batch>
scripts/dispatch.sh batch status --batch <batch>
scripts/dispatch.sh batch clean --batch <batch> --yes
```

Batch cleanup refuses paths outside a specific batch under the repository's dispatcher batch root.

## Requirements

- Herdr `0.7.0` or newer.
- Node.js `20` or newer.
- Herdr plus an agent CLI. The default command is `opencode`, which the dispatcher runs as `opencode --prompt "$(cat .herdr-worktree-dispatcher/PROMPT-<label>.md)"` inside the child worktree.

## Install From npm

```bash
npm install -g herdr-worktree-dispatcher
herdr-worktree-dispatcher install --agent all
```

The npm package is built during `npm pack` / `npm publish` using `prepack`, so users do not need TypeScript installed globally or a local build step.

`install` links the Herdr plugin, creates `config.env` if it does not already exist, and installs the companion skill. Supported skill targets are OpenCode, Claude Code, Codex, and Pi:

```bash
herdr-worktree-dispatcher install --agent opencode
herdr-worktree-dispatcher install --agent claude
herdr-worktree-dispatcher install --agent codex
herdr-worktree-dispatcher install --agent pi
herdr-worktree-dispatcher install --agent all
herdr-worktree-dispatcher install --skill-dir ~/.custom-agent/skills
```

Without `--agent`, the installer auto-detects existing agent homes and only installs matching skills. `--agent all` creates all default skill directories. Pi skills install to `~/.pi/agent/skills`.

## Install For Local Development

```bash
npm install
npm run init
herdr plugin action list --plugin worktree.dispatcher
```

The init command builds this checkout, links it as the `worktree.dispatcher` Herdr plugin, creates `$(herdr plugin config-dir worktree.dispatcher)/config.env` from `examples/config.env` if it does not already exist, symlinks the companion `worktree-dispatcher` skill into detected local agent skill directories, and installs shortcut commands where the target agent supports them.

Useful install variants:

```bash
node dist/cli.js init --plugin-only
node dist/cli.js init --skip-skill
node dist/cli.js init --skip-commands
node dist/cli.js init --force-command
node dist/cli.js init --skill-dir ~/.claude/skills --copy-skill
node dist/cli.js init --command-dir ~/.claude/commands
```

Shortcut commands installed by `init`:

- OpenCode: adds `dispatch` and `dispatch-team` entries to `~/.config/opencode/opencode.json` without overwriting existing commands unless `--force-command` is used.
- Claude Code: writes `dispatch.md` and `dispatch-team.md` to `~/.claude/commands`.
- Codex and Pi: slash-command storage is not standardized, so `init` installs `dispatch` and `dispatch-team` as skill aliases in their skill directories and reports that direct slash-command installation was skipped.

Use `/dispatch` for the normal single-worker dispatcher flow and `/dispatch-team` for the shared-worktree leader/worker team flow.

## Run Directly

```bash
scripts/dispatch.sh add --merge -- "implement the task"
```

Run the dispatcher from the target git workspace. `--cwd` is intentionally unsupported; if the current workspace/PWD is not inside a git repository, dispatch fails.

When invoking the dispatcher from another repository, prefer that repository's script and fall back to the installed CLI:

```bash
if [ -f scripts/dispatch.sh ]; then
  bash scripts/dispatch.sh add --merge -- "implement the task"
else
  herdr-worktree-dispatcher add --merge -- "implement the task"
fi
```

The repository includes `examples/config.env` as a user-level template for agent and layout preferences. Your real local user config should live in Herdr's plugin config directory:

```bash
mkdir -p "$(herdr plugin config-dir worktree.dispatcher)"
cp examples/config.env "$(herdr plugin config-dir worktree.dispatcher)/config.env"
```

When Herdr runs the plugin, `scripts/dispatch.sh` automatically reads `$HERDR_PLUGIN_CONFIG_DIR/config.env` if it exists. Use `--config` only to override that path for one command.

Project-specific setup belongs in the target repository, not in the user-level config. Put repo-local preflight commands in `.herdr-worktree-dispatcher/config.env` at the target repo root:

```ini
[worktree.preflight]
strict = true
prepare_command = make bootstrap
verify_command = make test
```

The dispatcher loads user config first and project config second, so project defaults can override user defaults for that repository. Explicit `--config` remains a one-command override and does not automatically merge project config.

Use a config profile so daily commands stay short:

```bash
scripts/dispatch.sh add --profile fast -- "fix the bug"
```

When running outside Herdr's plugin environment, point the dispatcher at a config file:

```bash
export HERDR_WORKTREE_DISPATCHER_CONFIG=/path/to/config.env
scripts/dispatch.sh add --profile fast -- "fix the bug"
```

Use a prompt file for larger tasks:

```bash
scripts/dispatch.sh add -P /tmp/task.md
```

By default, the dispatcher creates a branch like `worktree/<task-slug>-<timestamp>` so repeated smoke tests or repeated task prompts do not collide. Use `--branch` only when you need a specific branch name.

The workspace label is generated from task keywords rather than raw file paths or line numbers. If you want an exact sidebar name, pass `--name`:

```bash
scripts/dispatch.sh add --name "readme-install-docs" -- "update README installation instructions"
```

Choose the pane layout for the child agent:

```bash
scripts/dispatch.sh add --layout right -- "fix the bug"
scripts/dispatch.sh add --layout down -- "fix the bug"
```

The dispatcher creates the worktree through Herdr and starts the child agent in a split inside that worktree workspace. `right` opens the agent to the right. `down` opens the agent below. The child agent starts without taking focus, so you can keep working from the pane that launched the task.

Smoke-test the dispatcher without asking the child agent to edit code:

```bash
scripts/dispatch.sh add --merge --smoke-test -- "test task"
```

Smoke tests run in a worktree. With `--merge`, the child agent only executes the merge command if it actually creates a commit; no-change smoke tests leave the agent/worktree open for inspection.

Use `--merge` for normal dispatches so changed worktrees can come back automatically:

```bash
scripts/dispatch.sh add --merge -- "fix the bug and verify it"
```

`--merge` does not block the `add` phase. It writes a lifecycle token and gives the child agent an exact `scripts/dispatch.sh merge --token PATH` command. The prompt tells the child agent to run that command only after it has verified and committed its own changes. If it made no changes or no commit, it must not run merge/cleanup and should leave the worktree open.

Run a merge token manually if the child agent reports it instead of executing it:

```bash
scripts/dispatch.sh merge --token /tmp/herdr-worktree-dispatcher-cleanup/task-20260628120000-12345.json
```

Send a follow-up message to a dispatched worker using the same lifecycle token:

```bash
scripts/dispatch.sh message --token /tmp/herdr-worktree-dispatcher-cleanup/task-20260628120000-12345.json -- "please also check the docs"
```

You can also target any Herdr agent directly:

```bash
scripts/dispatch.sh message --agent wt-fix-the-bug -- "please pause before merging"
```

Dispatch an analysis task:

```bash
scripts/dispatch.sh add --merge -- "analyze the implementation and write findings to docs/implementation-review.md"
```

Analysis, review, research, and planning tasks still produce files, typically Markdown reports. The child agent should only skip merge/cleanup when the user explicitly asks for chat-only output or no file changes.

For multiple tasks, split them by dependency. Numbered or bulleted issue lists are parallel by default: dispatch each independent item as its own worker unless there is a concrete dependency or likely edit conflict. Dependent tasks should wait for their prerequisites to merge or publish their artifact path.

Use another interactive agent command:

```bash
scripts/dispatch.sh add --agent "opencode" -- "fix the failing test"
```

The dispatcher writes the prompt to `.herdr-worktree-dispatcher/PROMPT-<label>.md` inside the child worktree and adds that directory to git exclude. The default `opencode` command starts as `opencode --prompt "$(cat .herdr-worktree-dispatcher/PROMPT-<label>.md)"`. In plain, non-team dispatches, interactive `codex` starts with `-a never -s workspace-write --dangerously-bypass-hook-trust` and receives the prompt as its initial argument, so it can run unattended inside the worktree sandbox without timing-sensitive pane input. Explicit Codex approval, sandbox, or full-bypass options take precedence over these defaults. Team leader and worker commands are unchanged. Other custom agent commands are treated as interactive pane commands; for those, the dispatcher resolves the started pane and submits the prompt with `herdr pane send-text` and `herdr pane send-keys Enter`.

Authorize an additional writable directory for one plain Codex dispatch with repeated agent arguments:

```bash
scripts/dispatch.sh add --agent codex --agent-arg=--add-dir --agent-arg=/absolute/shared/path -- "use the shared files"
```

Pass arguments to the agent command:

```bash
scripts/dispatch.sh add --agent "opencode" --agent-arg "--model=gpt-5.1" -- "fix the bug"
scripts/dispatch.sh add --agent "opencode" --agent-arg "--debug" --agent-arg "--model=gpt-5.1" -- "fix the bug"
```

## Agent Skill

Copy or symlink the whole `skills/worktree-dispatcher` directory into your coding agent's skills directory if you want a `worktree-dispatcher` skill instruction. Include both `SKILL.md` and `scripts/dispatch.sh`; the skill-local script is the stable entrypoint agents call when the target repo does not have its own dispatcher script.

The skill is intentionally narrow: it tells the current agent not to inspect the repo before dispatching and to call `add --merge`. The child prompt makes merge/cleanup conditional on an actual commit.

Broad requests such as "分析当前实现" or "分析代码实现" are intentionally treated as sufficient context for repository-wide analysis, so the dispatcher skill should not ask a follow-up question for a file or feature name.

Short prompts that should trigger the skill in OpenCode:

```text
派发：修复登录刷新问题
分发这个任务：review 当前实现并写到 docs/review.md
开 worker 做：给 README 补安装说明
用 dispatcher 跑：分析 cleanup 流程并产出报告
send to worker: fix the failing test
```

## Config File

The config file is named `config.env` to match common Herdr plugin setup docs, but its content is INI-like. `[default]` applies first, then `[profile.NAME]` overrides it. Repeated `agent_arg` keys append arguments.

```ini
[default]
agent = opencode
language = zh-CN
layout = right

[profile.merge]
agent_arg = --model=gpt-5.1
merge = true
```

Supported user-level keys are `agent`, repeated `agent_arg`, `language`, `layout`, `merge`, `merge_mode`, and `team`. `language` defaults to `zh-CN` and controls natural-language summaries and generated human-readable file content in both plain and team dispatches. `merge_mode` defaults to `rebase` and can be set to `merge`. CLI flags such as `--layout` and `--merge-mode` override config values.

Repo-local `.herdr-worktree-dispatcher/config.env` also supports `[worktree.preflight]` with `strict`, `prepare_command`, and `verify_command`. Team worker spawn automatically checks git index readiness before opening a worker pane. When `prepare_command` is configured, spawn runs that command in the shared worktree; otherwise package-manager install is inferred only when dependencies are missing. When `strict = true`, missing project preflight commands become blockers instead of warnings.

In team mode, the leader pane is the user-facing coordination surface. The top-level `language` value is shared by the leader and every worker. Worker panes show detailed CI-style execution logs and the dispatcher saves the same output under `.herdr-worktree-dispatcher/runs/`. Workers record structured checklists with `team plan`, phase updates with `team update`, and final results with `team finish`; leaders catch up with `team events`. `team status` is a diagnostic fallback, not the primary progress UI. The final commit and merge are handled by the `shipper` role.

## Notes

This plugin does not reimplement Workmux. It delegates worktree creation and removal to Herdr, then composes Herdr's public agent-start surface to run the child agent.

New changes should be made in `src/` and compiled with `npm run build` for local testing. `dist/` is ignored by git and generated automatically for npm packages by `npm run build` via `prepack`.
