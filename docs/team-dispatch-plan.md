# 小队分发实现计划

## 状态

提案中。

## 背景

当前 `herdr-worktree-dispatcher` 的主流程是一条单 worker 直线：

1. 创建一个 Herdr worktree。
2. 在这个 worktree 里启动一个 agent。
3. agent 完成后通过 merge token 把 worktree 分支合回 source checkout。
4. trace/stats 统计这一次 agent run。

下一步要支持“小队”模型：一次任务由一个 leader agent 负责调度多个不同职责的 worker agent 协作完成。这个模型参考 `agency-agents` 的角色/persona 思路，但 dispatcher 负责的是运行时编排，不是只安装一批 persona 文件。

第一版小队不做并行和多 worktree 合并，先做一个可控、可观测、可逐步扩展的 MVP。

已确认约束：

- 一个小队只有一个 leader。
- worker 先只支持串行执行。
- leader 和 worker 共用同一个 Herdr worktree、同一个 git 分支。
- leader 决定什么时候启动哪个 worker role。
- dispatcher 负责强制串行锁，同一时间只允许一个 worker 处于 running。
- 现有非 team 的 `add` 行为必须保持不变。

## 关键概念

### role 和 runtime 是正交概念

`role` 和 `runtime` 不应该混在一起。

```text
role = 小队成员负责什么
runtime = 用哪个 agent 程序来执行这个职责
```

例如：

```text
role: designer
runtime: claude

role: reviewer
runtime: pi

role: tester
runtime: opencode

role: implementer
runtime: codex
```

不要把 `pi-reviewer`、`codex-tester` 这类组合当成一等类型，否则 role 和 runtime 一多，组合会迅速膨胀。

### 拓扑角色和业务角色分开

trace/state 里需要同时记录拓扑角色和业务角色：

```ts
agent_role: 'leader' | 'worker';
worker_role?: string;
agent_kind: 'pi' | 'opencode' | 'codex' | 'claude' | 'unknown';
```

- `agent_role` 表示拓扑位置：leader 或 worker。
- `worker_role` 表示业务职责：例如 `designer`、`reviewer`、`tester`、`security_auditor`。
- `agent_kind` 表示运行环境：Pi、OpenCode、Codex、Claude 等。

这样 stats 后续可以回答两类问题：

- `reviewer` 这个职责整体表现怎么样？
- Pi/Codex/Claude/OpenCode 这些 runtime 在不同职责上表现怎么样？

### role 不能写死

系统内核不应该只支持固定的 `planner/implementer/reviewer/tester/docs`。这些只能是内置 preset 的默认 role，不是系统能力边界。

role 应该是自由字符串：

```text
designer
ux_researcher
security_auditor
perf_benchmarker
frontend
backend
copywriter
```

dispatcher 只要求 role 有最小元数据和 prompt 来源。用户可以通过配置新增任意 role，例如 `designer`。

## 配置设计

### 配置格式沿用现有 INI 风格

项目现有 `examples/config.env` 是 INI 风格，而不是传统大写 `.env`：

```ini
[default]
agent = opencode
layout = right

[profile.fast]
agent = opencode
agent_arg = --model=gpt-5.1
layout = down
```

team 配置也应沿用这个风格，不引入一套全新的大写变量配置面。

### 内置 preset + 用户覆盖

推荐模型：

```text
内置 team preset = 默认结构和默认 prompt
config.env = 少量覆盖和自定义 role
```

内置 preset 负责开箱可用。用户配置负责覆盖 runtime、禁用/新增 role、指定自定义 prompt 文件。

不要要求用户把完整小队组织架构都写出来。常见情况应该只需要覆盖少数字段。

### 基础 team 配置

```ini
[default]
agent = opencode
layout = right
team = engineering

[team.engineering]
leader_agent = pi
worker_agent = codex
max_active_workers = 1
```

含义：

- 默认 team preset 是 `engineering`。
- leader 默认用 Pi。
- worker 默认用 Codex。
- 同一时间最多一个 active worker。

### 覆盖部分 role 的 runtime

如果只想覆盖某几个 role 的 runtime，可以写 compact override：

```ini
[team.engineering]
leader_agent = pi
worker_agent = codex
workers = reviewer:claude,tester:opencode
```

含义：

- `reviewer` 用 Claude。
- `tester` 用 OpenCode。
- 其他 worker role 继续用内置默认或 `worker_agent`。

### 禁用 role

```ini
[team.engineering]
disabled_roles = docs
```

`disabled_roles` 只影响该 team preset 的可用 role 列表。

### 新增自定义 role

自定义 role 使用 section：

```ini
[team.product-ui]
leader_agent = pi
worker_agent = codex
roles = designer,frontend,reviewer,tester
max_active_workers = 1

[team.product-ui.role.designer]
name = UI Designer
description = Review UX, layout, visual hierarchy, accessibility, and interaction states
agent = claude
emoji = 🎨
color = purple
vibe = Creates accessible interfaces that feel intentional
tools = read,grep,browser
prompt_file = .herdr/team/designer.md
output = docs/reports/design-review.md
success = identifies UX risks with file/line evidence and concrete recommendations
```

这里 `designer` 是用户定义的自由字符串 role。dispatcher 不需要发版才能支持它。

### 覆盖内置 role

同样的 section 也可以覆盖内置 role：

```ini
[team.engineering.role.reviewer]
agent = claude
prompt_file = .herdr/team/reviewer.md
success = findings are severity-ranked with file and line references
```

### role 配置字段

参考 `agency-agents` 的 agent 文件结构，每个 role 可以配置以下字段。

MVP 必须支持：

```ini
name = Code Reviewer
description = Review current diff for correctness, security, maintainability, and missing tests
agent = claude
prompt = Short inline prompt
prompt_file = .herdr/team/reviewer.md
output = docs/reports/review.md
success = severity-ranked findings with file/line evidence
```

建议预留支持：

```ini
emoji = 👁️
color = purple
vibe = Reviews code like a mentor, not a gatekeeper
tools = read,grep,bash
handoff = summarize findings and recommend next action to leader
```

字段说明：

- `name`：展示名，用于 leader prompt、status、stats。
- `description`：一句话说明这个 role 什么时候该被使用。
- `agent`：该 role 默认 runtime，例如 `pi`、`codex`、`claude`、`opencode`。
- `prompt`：短内联 prompt。
- `prompt_file`：长 prompt 文件，推荐用于复杂 role。
- `output`：期望产物路径或产物类型。
- `success`：成功标准，适合 reviewer/tester/designer。
- `emoji`、`color`、`vibe`：可读性和未来 UI 元数据，不影响执行。
- `tools`：期望工具能力，MVP 可只作为 prompt 信息，不做硬权限控制。
- `handoff`：worker 完成后应该交给 leader 的摘要要求。

`prompt` 和 `prompt_file` 可以二选一。如果都不写，dispatcher 使用通用 worker prompt 模板，把 role 名、description、task、completion command 注入进去。

### prompt 文件结构

长 prompt 文件可以直接借鉴 `agency-agents` 的结构：

```markdown
# UI Designer

## Identity
You are a UI designer focused on visual hierarchy, accessibility, and interaction quality.

## Core Mission
Review the current implementation and identify UX/design issues.

## Critical Rules
- Do not modify files unless explicitly asked.
- Cite file paths and line numbers for findings.
- Prefer concrete recommendations over vague design advice.

## Workflow
1. Locate relevant UI files.
2. Inspect layout, states, accessibility, and responsive behavior.
3. Produce a report.

## Deliverable
Write `docs/reports/design-review.md`.

## Success Metrics
- Findings are actionable.
- Evidence is file-backed.
- Recommendations are scoped.
```

### 配置解析规则

team profile 最终由三层合成：

```text
built-in team preset
+ [team.<name>] team-level override
+ [team.<name>.role.<role>] role override or custom role
```

role 集合解析：

```text
如果 [team.<name>] roles 存在：使用 roles 作为最终 role 列表
否则：使用 built-in preset roles + 自定义 role sections
最后：移除 disabled_roles
```

leader runtime 解析：

```text
CLI --leader-agent
> [team.<name>] leader_agent
> [profile.<name>] agent
> [default] agent
> built-in leader defaultRuntime
```

worker runtime 解析：

```text
team spawn --agent
> [team.<name>.role.<role>] agent
> [team.<name>] workers 中 role 对应 runtime
> [team.<name>] worker_agent
> built-in role defaultRuntime
> built-in team defaultWorkerRuntime
> error: no runtime configured
```

不要默认继承 leader runtime。如果要继承，必须在 preset 或配置里显式表达，例如：

```ini
[team.local]
worker_agent = inherit-leader
```

## 外部 role catalog

### 是否内联 `msitarzewski/agency-agents`

不建议把 `msitarzewski/agency-agents` 全量内联进 dispatcher 代码或 npm 包。

原因：

- 体量太大，会让 dispatcher 包和安装内容变重。
- upstream 更新后需要同步、处理冲突、维护 attribution，长期维护成本高。
- 它是通用 persona roster，不是专门为 Herdr 共享 worktree 串行 worker 设计的，直接内置会混入很多不适合默认小队的角色。
- role 太多会让 leader 选择困难，降低调度质量。
- 一些 runtime 对可注册 agent 数量有限制，默认带全量 roster 可能破坏体验。
- 用户不一定需要全量 catalog，大多数 team 只需要 3 到 6 个 role。

推荐做法：把 `agency-agents` 当成可选外部 role catalog，而不是默认内置内容。

```text
built-in presets
  engineering
  review
  product-ui

external catalogs
  agency-agents
  local .herdr/team/roles
  future org shared catalog
```

### MVP 支持本地 catalog path

第一版不要自动下载外部仓库。用户如果想使用 `agency-agents`，可以自己 clone，然后在 config 里引用本地路径：

```ini
[team.product-ui]
leader_agent = pi
catalog_path = ~/src/agency-agents
roles = design-ui-designer,engineering-frontend-developer,engineering-code-reviewer,testing-reality-checker
```

也可以使用相对路径：

```ini
[team.product-ui]
catalog_path = .herdr/catalogs/agency-agents
roles = design-ui-designer,engineering-frontend-developer,testing-reality-checker
```

dispatcher 从 `catalog_path` 读取 agent markdown，提取 frontmatter 和正文，并映射成 `TeamRole`。

### `agency-agents` 字段映射

`agency-agents` 的 markdown frontmatter 结构大致是：

```yaml
---
name: UI Designer
description: Expert UI designer specializing in visual design systems...
color: purple
emoji: 🎨
vibe: Creates beautiful, consistent, accessible interfaces that feel just right.
tools: optional
---
```

映射到 dispatcher role：

```ts
interface CatalogRole {
  role: string;        // slug，例如 design-ui-designer
  name: string;        // UI Designer
  description: string;
  color?: string;
  emoji?: string;
  vibe?: string;
  tools?: string[];
  prompt: string;      // markdown body
  source: 'agency-agents' | 'local';
  source_path: string;
}
```

正文直接作为长 prompt 内容，保留它已有的结构：

- Identity / Memory
- Core Mission
- Critical Rules
- Deliverables
- Workflow Process
- Output Template
- Communication Style
- Success Metrics

### role 命名和引用

外部 catalog 的 role id 应该稳定、可读、避免跨 division 冲突。

建议使用：

```text
<division>-<agent-slug>
```

例如：

```text
design-ui-designer
engineering-frontend-developer
engineering-code-reviewer
testing-reality-checker
specialized-agents-orchestrator
```

team 里显式选择 role：

```ini
[team.ui-review]
catalog_path = ~/src/agency-agents
roles = design-ui-designer,engineering-frontend-developer,engineering-code-reviewer,testing-reality-checker
```

不要把整个 catalog 暴露给 leader。leader prompt 只展示当前 team profile 显式选择的 roles。

### catalog role 覆盖

用户仍然可以用 `[team.<name>.role.<role>]` 覆盖外部 catalog role 的字段：

```ini
[team.ui-review.role.design-ui-designer]
agent = claude
output = docs/reports/design-review.md
success = identifies visual hierarchy and accessibility issues with concrete evidence

[team.ui-review.role.testing-reality-checker]
agent = opencode
tools = read,grep,bash,browser
```

覆盖规则：

```text
catalog role frontmatter/body
+ [team.<name>.role.<role>] override
```

如果同名 role 同时存在于 built-in preset 和 external catalog，应要求用户明确选择或者报冲突，不要静默覆盖。

### catalog 命令计划

MVP 可以先只实现配置加载；后续增加只读命令方便发现 role：

```bash
herdr-worktree-dispatcher team catalog list --path ~/src/agency-agents
herdr-worktree-dispatcher team catalog show --path ~/src/agency-agents design-ui-designer
```

未来可增加导入命令，把选中的外部 role 缓存到本地 dispatcher config 目录：

```bash
herdr-worktree-dispatcher team catalog import agency-agents --division design,engineering,testing
```

但导入不是 MVP 必需能力。MVP 只需要支持 `catalog_path` + `roles` 显式引用。

### catalog 安全边界

外部 catalog markdown 是数据，不是可信命令。

规则：

- 不执行 catalog 里的 shell 命令。
- 不从 catalog 里读取 runtime 启动命令。
- `tools` 只是声明期望能力，MVP 不做硬权限授予。
- `prompt` 只作为 worker prompt 的一部分注入。
- 文件读取限制在 `catalog_path` 下。
- 如果 prompt 中出现让 worker 绕过 dispatcher、创建额外 worktree、跳过 merge token 的指令，dispatcher 的 outer prompt 必须覆盖这些内容。

### 是否支持远程 catalog

MVP 不支持直接从 GitHub URL 拉 catalog。

原因：

- 网络失败会影响核心 dispatch 体验。
- 远程内容的版本和 trust 边界不清晰。
- 本地 path 更容易调试和复现。

未来如果支持远程 catalog，应先下载到本地 cache，并记录：

- source URL
- commit SHA
- fetched_at
- license/attribution

## catalog 与内置 preset 的关系

内置 preset 仍然必要。

原因：

- 提供零配置体验。
- 作为 schema 示例。
- 让测试稳定，不依赖外部 repo。
- 为 Herdr shared-worktree 串行 worker 模式提供原生 prompt。

外部 catalog 是增强能力，不是默认依赖。

推荐优先级：

```text
1. Herdr-native built-in roles: 小而稳定，适合作为默认体验
2. Local custom roles: 用户自己维护的角色
3. External catalog roles: agency-agents 等大型角色库
```

Team profile 可以混合使用内置 role 和 catalog role，但必须显式列出最终 roles，避免 leader 面对过大的候选集。

## 命令设计

### 启动小队

```bash
herdr-worktree-dispatcher add --team engineering --leader-agent pi "Implement X"
```

简化路径：

```bash
herdr-worktree-dispatcher add --team "Implement X"
```

如果 `--team` 没有显式 team 名，则使用 `[default] team`，再 fallback 到内置 `engineering`。

### leader 启动 worker

```bash
herdr-worktree-dispatcher team spawn --token <team-token> --role reviewer "Review the current diff"
```

覆盖 runtime：

```bash
herdr-worktree-dispatcher team spawn --token <team-token> --role designer --agent claude "Review the design"
```

### worker 完成

```bash
herdr-worktree-dispatcher team done --token <team-token> --worker <worker-id>
```

### 查看状态

```bash
herdr-worktree-dispatcher team status --token <team-token>
```

### 给 worker 发消息

```bash
herdr-worktree-dispatcher team message --token <team-token> --worker <worker-id> "Clarification"
```

第一版不需要 `team merge`。最终仍由 leader 在共享 worktree 中提交，并执行现有 merge token 命令。

## 状态模型

team state 存在 worktree 外，避免被 cleanup 删除，也方便 leader/worker 命令更新。

建议路径：

```text
${TMPDIR}/herdr-worktree-dispatcher-teams/<team_id>.json
```

### TeamState

```ts
interface TeamState {
  mode: 'team';
  team_id: string;
  profile: string;
  source_cwd: string;
  source_branch: string;
  base_commit: string;
  shared_workspace_id: string;
  shared_worktree_path: string;
  branch: string;
  merge_token_path: string;
  team_token_path: string;
  leader: TeamMember;
  workers: TeamMember[];
  active_worker_id?: string;
  created_at: string;
  updated_at: string;
}
```

### TeamMember

```ts
interface TeamMember {
  member_id: string;
  team_id: string;
  agent_run_id: string;
  parent_agent_run_id?: string;
  agent_name: string;
  agent_role: 'leader' | 'worker';
  worker_role?: string;
  agent_kind: 'pi' | 'opencode' | 'codex' | 'claude' | 'unknown';
  workspace_id: string;
  worktree_path: string;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  completed_at?: string;
  prompt_file?: string;
}
```

## prompt 要求

### leader prompt

leader prompt 必须包含：

- 原始任务。
- 共享 worktree 路径。
- 可用 role 列表，包括用户自定义 role。
- 每个 role 的 `name`、`description`、`vibe`、`success` 摘要。
- worker 串行规则：同一时间只能有一个 worker。
- `team spawn`、`team done`、`team status`、`team message` 的精确命令。
- 每个 worker 完成后，leader 必须检查 `git diff`。
- leader 负责最终提交和 merge。

leader 不允许手动创建 Herdr worktree。所有 worker 创建必须通过 dispatcher 命令。

### worker prompt

worker prompt 必须包含：

- role 名和 role 配置。
- 子任务文本。
- 它正在共享 leader worktree。
- 不要提交、不要 merge。
- 只做当前 role/task 范围内的工作。
- 必须执行完成命令：

```bash
herdr-worktree-dispatcher team done --token <team-token> --worker <worker-id>
```

如果 role 配置了 `output`，worker prompt 应明确要求产出该文件或对应类型的产物。

## trace 和 stats 变更

Trace record 增加：

```ts
worker_role?: string;
```

Stats 输出展示拓扑角色、业务 role 和 runtime：

```text
By Agent:
  leader/orchestrator  pi       wt-task-leader      12 calls  40s
  worker/designer      claude   wt-task-designer     6 calls  45s
  worker/reviewer      codex    wt-task-reviewer     8 calls  11s
  worker/tester        pi       wt-task-tester       5 calls  20s
```

后续可增加：

- 每个 agent 的 idle time。
- 每个 agent 的 top idle gaps。
- worker 之间的重复工作检测。
- team critical path。

## 实现阶段

### Phase 1: Team State Foundation

验收标准：

- 有 team state 类型。
- 有 team state read/write/update helper。
- 有 active worker 串行锁逻辑。
- 测试覆盖 state 创建、更新、锁冲突、坏 state 报错。

可能涉及：

- `src/team/types.ts`
- `src/team/state.ts`
- `test/teamState.test.mjs`

### Phase 2: Team Profile And Role Config

验收标准：

- 内置 `engineering` preset。
- role 是自由字符串，不是 enum。
- 支持 `[team.<name>]` 和 `[team.<name>.role.<role>]` 配置覆盖。
- 支持 `name`、`description`、`agent`、`prompt`、`prompt_file`、`output`、`success`。
- 测试覆盖自定义 `designer` role。

可能涉及：

- `src/team/profiles.ts`
- `src/config/config.ts`
- `test/teamProfiles.test.mjs`

### Phase 3: Team Prompts

验收标准：

- leader prompt 包含所有可用 role 和 dispatcher 命令。
- worker prompt 包含 role config、子任务、共享 worktree 说明、`team done` 命令。
- 测试覆盖内置 role 和自定义 role prompt。

可能涉及：

- `src/prompt/teamPrompt.ts`
- `test/teamPrompt.test.mjs`

### Phase 4: `add --team`

验收标准：

- `add --team engineering` 创建共享 worktree 并启动 leader。
- team state 包含 leader、merge token、shared worktree、profile。
- 非 team 的 `add` 行为不变。

可能涉及：

- `src/commands/add.ts`
- `src/token/token.ts`
- `src/trace/types.ts`

### Phase 5: `team spawn` 和 `team done`

验收标准：

- `team spawn` 在同一个 worktree 里启动 worker。
- `team spawn` 在已有 running worker 时拒绝。
- `team done` 标记 worker done 并清空 active lock。
- worker trace metadata 包含 `team_id`、leader parent id、`worker_role`。

可能涉及：

- `src/commands/team.ts`
- `src/herdr/client.ts`
- `src/trace/paths.ts`
- `test/teamCommands.test.mjs`

### Phase 6: `team status` 和 `team message`

验收标准：

- `team status` 展示 leader、active worker、完成的 workers、branch、shared worktree、git dirty 状态。
- `team message` 能给 active worker 或指定 worker 发消息。

可能涉及：

- `src/commands/team.ts`
- `src/git/git.ts`
- `test/teamCommands.test.mjs`

### Phase 7: Team Stats

验收标准：

- trace/stats 支持 `worker_role`。
- stats 按 leader/worker role 展示。
- 同一 `team_id` 的 leader 和 workers 能聚合展示。

可能涉及：

- `src/trace/types.ts`
- `src/trace/stats.ts`
- `src/trace/format.ts`
- `test/trace.test.mjs`

## 风险和缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| leader 和 worker 共用 worktree，可能互相覆盖文件 | 中 | 强制 worker 串行；worker 不提交；leader 在每个 worker 后检查 `git diff`。 |
| worker 忘记执行 `team done` | 中 | `team status` 显示 stuck worker；后续可加 `team done --force`。 |
| role/runtime 语义混乱 | 中 | 文档和类型中明确 `worker_role` 与 `agent_kind` 分离。 |
| 用户配置过重 | 高 | 内置 preset 开箱可用；配置只做覆盖；自定义复杂 prompt 用 `prompt_file`。 |
| 自定义 role 拼写错误导致误跑 | 中 | MVP 默认拒绝未知 role，提示配置 `[team.<name>.role.<role>]`。 |
| team 模式影响现有 `add` | 高 | 非 team code path 保持独立；测试覆盖原有 CLI/help 和 add prompt。 |

## MVP 非目标

- 并行 workers。
- worker 独立 worktree。
- 多 worker 分支自动合并。
- 远程 role marketplace。
- per-role 真实工具权限限制。
- 自动 QA retry loop。
- 所有 runtime hook 能力完全一致。

## 开放问题

- `roles` 字段应该表示“最终 role 列表”，还是只表示“追加 role 列表”？当前建议表示最终列表。
- 是否需要 `add_roles` 这种更轻的追加语义？
- `team done` 是否允许附带 summary，例如 `--summary <text>` 或 stdin？
- `team status` 是否默认显示最近的 tool failures？
- MVP 是否需要 `team done --force` 来解除卡住的 active worker？
