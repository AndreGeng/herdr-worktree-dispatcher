---
name: worktree-dispatcher
description: 将单个任务或飞书 Base 外部任务批次派发到临时 git worktree 并启动 worker agent。触发词：派发、分发、开 worker、起 worker、让 worker 做、飞书 Base、多维表格任务、用 worktree-dispatcher、用 dispatcher、dispatch this、send to worker。
allowed-tools: Bash, Write
---

# Worktree Dispatcher

将一个任务派发到临时 git worktree。默认总是使用 `add --merge` 创建 worktree 并启动子 agent，同时提供条件式 `merge --token PATH` 收尾命令：有提交才合回，没有改动就不执行 merge/cleanup。

## 硬性规则

你是 dispatcher，不是实现者。对于普通任务，不要在派发前探索、读取、grep、glob 或搜索代码库。只要用户给出了足够的任务上下文，就立即调用 dispatcher；如果上下文不足，只问一个澄清问题。

飞书 Base URL 是外部任务数据源，不是已经确认的任务范围。检测到 `/base/` URL 时，不得直接调用 `add`，必须走下文的 Connector 批次流程。未确认筛选范围、未检查每张图片、未通过 batch verify、或未获得最终派发确认时，不得创建 worktree。

像“分析当前实现”“分析代码实现”“分析这个项目”“review the implementation”“explain this repo”这类宽泛请求，也视为上下文充足。把它们作为仓库级分析任务派发，不要追问具体文件或功能。

所有派发任务都必须有文件产出。实现任务产出代码/文档改动；分析、review、调研、解释、计划等任务也必须产出 Markdown 报告文件。除非用户明确说“只在聊天里回答/不要写文件”，否则不能让子 agent 只在 TUI 里返回文本。

如果用户说“生成”“写”“产出”“create”“write”“generate”“draft”“output”等，默认含义是让子 agent 在 worktree 中创建或修改实际文件，不是只在 TUI 里返回文本。prompt 要明确要求文件路径和产物格式。

如果用户一次给出多个任务，特别是编号列表、项目符号列表、多个“问题/需求/修复点”，dispatcher 必须先把它们拆成候选子任务。默认假设这些子任务可以并行，除非有明确证据表明它们依赖同一个前置结果、必须共享同一次大改、或会修改同一小段状态导致冲突。相互独立的任务必须拆成多个 `add --merge` worker 并发派发；不要把独立编号项塞给一个 worker。

并发派发前，用一句话记录拆分决策：哪些任务并行、哪些任务串行、为什么。如果没有明确依赖关系，就按并行处理。像“某页面有两个问题：1. A 2. B”默认是两个并行 worker，即使它们在同一页面，除非任务明显需要同一个重构先完成。

如果用户明确要求“小队/团队/team/leader/orchestrator/多个角色协作/让 leader 调 worker/reviewer 和 tester 一起做/designer 和 frontend 协作”，使用小队模式：只启动一个 team leader，让 leader 在共享 worktree 中串行调度 worker。不要把小队请求拆成多个独立 `add --merge` worktree。

小队模式只在用户明确要求时使用。普通“派发/分发/开 worker/让 worker 做”仍然走默认 `add --merge`，包括多个独立任务的并发派发。

如果用户已经提供 `team_token`，并要求诊断小队状态、查看事件、或给 worker 发消息，可以直接调用 `team status`、`team events`、`team message`。不要手动调用内部 worker 收尾命令。不要在没有现成 `team_token` 的情况下直接调用 `team spawn`；初次小队任务必须先用 `add --team ... --merge` 启动 leader，worker 调度交给 leader prompt。

如果用户明确说明当前已经在 dispatcher 创建的 worktree 中，并禁止再创建 worktree，不要调用 dispatcher。直接在当前 checkout 中处理任务，并遵循提示里的 source checkout / source branch 约束。

## 内置 Connector：飞书 Base

飞书 Base 已作为 dispatcher 的内置只读 connector 提供；不要调用或依赖独立的 `feishu-base-to-workers` skill。Connector 不更新飞书记录。

收到飞书 Base URL 后：

1. 调用 `source inspect <url>`。Inspect 只读取字段、视图摘要和附件元数据，不下载附件、不选择全部记录、不创建 worktree。
2. 读取批次的 `REVIEW.md`，向用户展示视图记录数、状态/优先级/负责人分布、字段映射歧义和附件规模。
3. 如果用户最初没有明确筛选条件，必须让用户确认。只有用户明确说使用当前视图全部记录时，才使用 `--all-visible-records`；否则把确认后的条件写入当前批次的 criteria JSON，再用 `--criteria`。
4. 字段映射有歧义时，只展示需要确认的 role、候选字段、分数和证据；将确认结果写入当前批次 mapping JSON，并通过 `source prepare --mapping` 传入。不要保存成全局映射。
5. 调用 `source prepare` 后，检查 `tasks/*.md` 和所有附件。每张图片必须使用实际图像查看能力逐张检查，并用事实观察替换 `ATTACHMENT_OBSERVATION_REQUIRED`；不得根据文件名推测。
6. 运行 `source refresh`，再运行 `batch verify`。任何来源变化、缺失附件、哈希错误、未完成图片观察、依赖错误或验证失败都必须停止。
7. 调用 `batch preview`，向用户展示一个统一预览：任务顺序、wave、agent/profile、附件数量、branch label、ready/blocked 状态和 confirmation digest。
8. 在创建任何 worktree 之前获得一次最终确认，然后用完全相同的 profile/config 和 digest 调用 `batch dispatch --confirm <digest>`。
9. `batch dispatch` 只启动最早 ready wave；同 wave 的独立任务分别进入独立 worktree。依赖任务等前置任务 merge 后，再重新 refresh/verify/preview/confirm 后续 wave。

常用命令：

```bash
bash "$DISPATCH_SH" source inspect 'https://tenant.feishu.cn/base/...?table=...&view=...'
bash "$DISPATCH_SH" source prepare --batch <batch> --criteria <criteria.json>
bash "$DISPATCH_SH" source prepare --batch <batch> --all-visible-records
bash "$DISPATCH_SH" source refresh --batch <batch>
bash "$DISPATCH_SH" batch verify --batch <batch>
bash "$DISPATCH_SH" batch preview --batch <batch> [--profile <name>]
bash "$DISPATCH_SH" batch dispatch --batch <batch> --confirm <digest> [--profile <name>]
```

批次的人类审阅入口是 `REVIEW.md`、`tasks/*.md` 和 `DISPATCH.md`。`.internal/*.json` 是 dispatcher 的机器状态，不要求用户直接阅读或编辑。批次保留到用户明确要求 `batch clean --batch <exact-path> --yes`。

## 用法

先解析 dispatcher 脚本路径。skill 自带 `scripts/dispatch.sh` wrapper；它依次尝试目标仓库本地脚本、当前 npm 包内的主脚本、以及 PATH 中安装的 `herdr-worktree-dispatcher` CLI。保留 wrapper 入口后，源码链接安装、复制安装和全局 npm 安装都能使用同一套命令。

默认派发命令：

```bash
DISPATCH_SH="<installed-skill-dir>/worktree-dispatcher/scripts/dispatch.sh"
bash "$DISPATCH_SH" add --merge -- "implement the requested change"
```

`--merge` 会让 `add` 创建 lifecycle token，并把精确的 `dispatch.sh merge --token PATH` 命令传给子 agent。子 agent 如果产生并提交了改动，就执行这个 merge 命令；如果没有改动或没有提交，就不要执行 merge/cleanup，直接报告没有内容需要合回并留在 worktree 里。

默认 agent 是 `opencode`。dispatcher 会把完整任务 prompt 写到子 worktree 内的 `.herdr-worktree-dispatcher/PROMPT-<label>.md`，并用 `opencode --prompt "$(cat .herdr-worktree-dispatcher/PROMPT-<label>.md)"` 启动子 agent。该目录会加入 git exclude，避免污染工作区状态。

小队模式命令：

```bash
bash "$DISPATCH_SH" add --team engineering --merge -- "implement the requested change with a leader coordinating serial workers"
```

如果用户指定 team profile，使用指定名称：

```bash
bash "$DISPATCH_SH" add --team product-ui --merge -- "review the UI with designer, reviewer, and tester roles"
```

如果用户指定 leader runtime，传 `--leader-agent`：

```bash
bash "$DISPATCH_SH" add --team engineering --leader-agent pi --merge -- "coordinate reviewers and testers for this task"
```

小队模式会创建一个共享 worktree、一个 leader agent、一个 `team_token`。leader prompt 会包含 `team spawn`、`team events`、`team status`、`team message` 的精确命令；worker prompt 使用 `team plan`、`team update`、`team finish` 上报结构化清单、阶段更新和最终结果。worker pane 是详细执行日志，dispatcher 自动保存日志并记录结构化事件；leader 用正常语言总结进展并选择下一角色；最终提交和 merge 由 shipper worker 执行。

已有小队的后续操作示例：

```bash
bash "$DISPATCH_SH" team status --token /tmp/herdr-worktree-dispatcher-teams/team-id.json
bash "$DISPATCH_SH" team events --brief --token /tmp/herdr-worktree-dispatcher-teams/team-id.json
bash "$DISPATCH_SH" team message --token /tmp/herdr-worktree-dispatcher-teams/team-id.json --worker worker-id "please check the failing test"
```

## Token 生命周期

`add --merge` 会在创建 Herdr worktree 后生成 lifecycle token 文件。这个 token 只用于“有提交时合回”。没有改动时，子 agent 不应执行 token 命令。

token 记录后续收尾需要的机器可读上下文，包括：

- `mode`：固定为 `merge`。
- `source_cwd` 和 `source_branch`：源 checkout 路径和源分支。
- `worktree_path` 和 `branch`：临时 worktree 路径和临时分支。
- `worktree_workspace_id`：Herdr 创建的 worktree workspace，用于收尾时删除 workspace。
- `merge_mode`：`rebase` 或 `merge`。

`add --merge` 会把 token 路径写入传给子 agent 的 prompt，并提供条件式收尾命令：

```bash
dispatch.sh merge --token PATH
```

`merge --token` 只接受 `mode=merge` token：先合回代码，再清理 worktree 和临时分支。

宽泛分析请求也要派发，但不要替换成固定任务。直接把用户原始意图写进 prompt，并要求产出 Markdown 报告文件，仍然使用 `--merge`。例如：

```bash
bash "$DISPATCH_SH" add --merge -- "分析当前项目的实现流程、关键入口、配置读取、外部集成、风险和改进建议。将结果写入 docs/implementation-analysis.md。"
```

如果用户已经说明了具体对象，例如“分析 worktree dispatcher 的 cleanup 流程”或“review 当前 PR”，就使用用户的具体描述，不要套用上面的示例。

长提示先写入临时文件，再派发，默认加 `--merge`：

```bash
bash "$DISPATCH_SH" add --merge -P /tmp/task.md
```

短实现任务：

```bash
bash "$DISPATCH_SH" add --merge -- "implement the requested change"
```

分析、review、解释类任务也加 `--merge`，并要求写 Markdown 报告文件：

```bash
bash "$DISPATCH_SH" add --merge -- "analyze the implementation and write findings to docs/implementation-review.md"
```

用户要求指定 Herdr pane 布局时，使用 `--layout right` 或 `--layout down`。

如果任务描述里有清晰对象，优先用 `--name` 传一个短而有意义的 label，例如 `readme-install-docs`、`fix-auth-refresh`、`review-cleanup-flow`。不要让 workspace 名称退化成文件名和行号。

用户要求给子 agent 传额外参数时，使用重复的 `--agent-arg VALUE`。

如果用户已经在 Herdr 外部配置了 profile，优先使用 `--profile NAME` 和 `HERDR_WORKTREE_DISPATCHER_CONFIG`，不要手写一堆重复的 agent/layout/merge 参数。

## 派发策略

默认使用 `--merge`，因为这个 skill 的目标是让有提交的 worktree 自动带回 source checkout。

分析、review、解释类任务也使用 `--merge`，因为它们也必须写报告文件并提交。如果用户明确要求不要写文件，子 agent 才能无改动并跳过 `merge --token` 和 cleanup。

多任务派发策略：先按依赖关系分层。每个独立任务一个 worker；同层任务并发派发。依赖后续任务时，不要提前派发到旧 base 上，避免冲突或重复工作。

小队模式和多 worker 并发派发是两种不同策略：默认多 worker 会创建多个独立 worktree 并发执行；小队模式只创建一个共享 worktree，由 leader 串行调度 worker。只有用户明确要求小队/team/leader/多角色协作时才使用小队模式。

dispatcher 会立即返回。子 agent 负责执行任务；只有产生提交时，才调用 dispatcher 提供的 `merge --token` 命令完成合回。

## 返回结果

默认派发时，向用户报告 branch、worktree path、agent name、cleanup log path，以及有无 `merge_command`。

小队模式时，向用户报告 `team_token`、team profile、leader agent name、shared worktree path、branch、merge token/merge command。提醒用户 leader pane 是小队进展和协调入口；`team status --token PATH` 只作为诊断兜底。
