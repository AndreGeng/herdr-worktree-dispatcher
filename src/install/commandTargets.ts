import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { expandHome, type SkillAgent } from './skillTargets.js';

export type CommandAgent = SkillAgent;

export interface CommandInstallResult {
  agent: CommandAgent | 'custom';
  command: 'dispatch' | 'dispatch-team' | 'all';
  status: 'installed' | 'merged' | 'kept' | 'skipped' | 'failed';
  path?: string;
  reason?: string;
}

export interface CommandInstallInput {
  agents: Array<CommandAgent | 'all'>;
  customCommandDirs: string[];
  packageRoot: string;
  forceCommand?: boolean;
  exists?: (path: string) => boolean;
  home?: string;
}

interface CommandTemplate {
  name: 'dispatch' | 'dispatch-team';
  description: string;
  opencodeTemplate: string;
  claudeBody: string;
}

export const commandTemplates: CommandTemplate[] = [
  {
    name: 'dispatch',
    description: '用 Herdr worktree-dispatcher 派发任务',
    opencodeTemplate: `使用 worktree-dispatcher skill 分发任务：$ARGUMENTS

要求：
- 不要在当前 checkout 里直接实现。
- 按 worktree-dispatcher skill 的规则调用 dispatcher，将任务派发到临时 git worktree 中的 agent。
- 默认使用 add --merge，让子 agent 在有提交时通过 dispatcher 提供的 merge token 合回。
- 如果任务是分析、review、解释或计划，也要求子 agent 产出并提交 Markdown 报告文件。
- 派发完成后立即汇报 branch、worktree path、agent name、cleanup log path，以及有无 merge command，然后停止。`,
    claudeBody: `Use the worktree-dispatcher skill to dispatch this task: $ARGUMENTS

Requirements:
- Do not implement directly in the current checkout.
- Follow the worktree-dispatcher skill rules.
- Use \`add --merge\`.
- If this is analysis, review, explanation, or planning, require a committed Markdown report artifact.
- After dispatching, report branch, worktree path, agent name, cleanup log path, and whether a merge command exists, then stop.
`,
  },
  {
    name: 'dispatch-team',
    description: '用 Herdr worktree-dispatcher 小队模式派发任务',
    opencodeTemplate: `使用 worktree-dispatcher skill 的小队模式分发任务：$ARGUMENTS

要求：
- 不要在当前 checkout 里直接实现。
- 调用 dispatcher 的 add --team engineering --merge，将 $ARGUMENTS 作为唯一任务文本派发给一个 leader agent，不要把本 command 的说明文字拼进任务。
- leader pane 是用户沟通和调度窗口；leader 不能直接实现、测试、review 或写文档，必须通过 team worker 推进任务。
- leader 会在同一个共享 worktree 中串行调度 worker role；你不要自己直接调用 team spawn，除非用户提供了现成 team_token 并要求继续操作已有小队。
- 如果任务是分析、review、解释或计划，也要求小队最终产出并提交 Markdown 报告文件。
- 派发完成后立即汇报 team_token、profile、leader agent name、shared worktree path、branch、merge token/merge command。
- 告诉用户 leader pane 是小队进展和协调入口；team status --token <team_token> 仅作为诊断兜底，然后停止。`,
    claudeBody: `Use the worktree-dispatcher skill team mode to dispatch this task: $ARGUMENTS

Requirements:
- Do not implement directly in the current checkout.
- Call dispatcher with \`add --team engineering --merge\`, passing only $ARGUMENTS as the task text. Do not include this command's orchestration instructions in the dispatched task.
- The leader pane is for user communication and orchestration. The leader must not implement, test, review, or document directly; it must advance the task by dispatching team workers.
- The leader will coordinate serial worker roles in one shared worktree.
- Do not directly call \`team spawn\` unless the user provided an existing \`team_token\`.
- If this is analysis, review, explanation, or planning, require a committed Markdown report artifact.
- After dispatching, report \`team_token\`, profile, leader agent name, shared worktree path, branch, merge token/merge command.
- Tell the user the leader pane is the team coordination surface; \`team status --token <team_token>\` is only a diagnostic fallback, then stop.
`,
  },
];

export function installCommands(input: CommandInstallInput): CommandInstallResult[] {
  const home = input.home ?? homedir();
  const exists = input.exists ?? existsSync;
  const agents = input.agents.length > 0 ? input.agents : detectCommandAgents(home, exists);
  const expandedAgents = agents.includes('all') ? (['opencode', 'claude', 'codex', 'pi'] as CommandAgent[]) : (agents as CommandAgent[]);
  const results: CommandInstallResult[] = [];
  for (const customDir of input.customCommandDirs) {
    results.push(...installClaudeCommands('custom', expandHome(customDir), input.forceCommand));
  }
  for (const agent of expandedAgents) {
    switch (agent) {
      case 'opencode':
        results.push(installOpenCodeCommands(join(home, '.config', 'opencode', 'opencode.json'), input.forceCommand, exists));
        break;
      case 'claude':
        results.push(...installClaudeCommands('claude', join(home, '.claude', 'commands'), input.forceCommand));
        break;
      case 'codex':
        results.push(...installSkillAliases('codex', join(home, '.codex', 'skills'), input.packageRoot, input.forceCommand, exists));
        results.push({ agent: 'codex', command: 'all', status: 'skipped', path: join(home, '.codex'), reason: 'Codex slash-command surface is unknown; installed skill aliases instead' });
        break;
      case 'pi':
        results.push(...installSkillAliases('pi', join(home, '.pi', 'agent', 'skills'), input.packageRoot, input.forceCommand, exists));
        results.push({ agent: 'pi', command: 'all', status: 'skipped', path: join(home, '.pi', 'agent'), reason: 'Pi slash-command surface is unknown; installed skill aliases instead' });
        break;
    }
  }
  return results;
}

export function mergeOpenCodeCommands(existing: unknown, forceCommand = false): { value: Record<string, unknown>; changed: boolean } {
  const root = isRecord(existing) ? { ...existing } : {};
  const currentCommand = isRecord(root.command) ? { ...root.command } : {};
  let changed = !isRecord(existing) || !isRecord(root.command);
  for (const template of commandTemplates) {
    if (currentCommand[template.name] && !forceCommand) continue;
    const next = { description: template.description, template: template.opencodeTemplate };
    if (JSON.stringify(currentCommand[template.name]) !== JSON.stringify(next)) {
      currentCommand[template.name] = next;
      changed = true;
    }
  }
  root.command = currentCommand;
  return { value: root, changed };
}

function installOpenCodeCommands(path: string, forceCommand: boolean | undefined, exists: (path: string) => boolean): CommandInstallResult {
  try {
    const existing = exists(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    const merged = mergeOpenCodeCommands(existing, forceCommand);
    const next = `${JSON.stringify(merged.value, null, 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    if (exists(path) && readFileSync(path, 'utf8') === next) return { agent: 'opencode', command: 'all', status: 'kept', path };
    writeFileSync(path, next);
    return { agent: 'opencode', command: 'all', status: merged.changed ? 'merged' : 'kept', path };
  } catch (error) {
    return { agent: 'opencode', command: 'all', status: 'failed', path, reason: errorMessage(error) };
  }
}

function installClaudeCommands(agent: 'claude' | 'custom', root: string, forceCommand: boolean | undefined): CommandInstallResult[] {
  const results: CommandInstallResult[] = [];
  mkdirSync(root, { recursive: true });
  for (const template of commandTemplates) {
    const path = join(root, `${template.name}.md`);
    const body = claudeCommandFile(template);
    try {
      if (existsSync(path) && readFileSync(path, 'utf8') === body) {
        results.push({ agent, command: template.name, status: 'kept', path });
      } else if (existsSync(path) && !forceCommand) {
        results.push({ agent, command: template.name, status: 'kept', path, reason: 'existing command kept; use --force-command to overwrite' });
      } else {
        writeFileSync(path, body);
        results.push({ agent, command: template.name, status: 'installed', path });
      }
    } catch (error) {
      results.push({ agent, command: template.name, status: 'failed', path, reason: errorMessage(error) });
    }
  }
  return results;
}

function installSkillAliases(agent: 'codex' | 'pi', root: string, packageRoot: string, forceCommand: boolean | undefined, exists: (path: string) => boolean): CommandInstallResult[] {
  const results: CommandInstallResult[] = [];
  mkdirSync(root, { recursive: true });
  for (const template of commandTemplates) {
    const path = join(root, template.name);
    try {
      if (exists(path) && !forceCommand) {
        results.push({ agent, command: template.name, status: 'kept', path, reason: 'existing skill alias kept; use --force-command to overwrite' });
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'SKILL.md'), skillAliasFile(template));
      const scriptsDir = join(path, 'scripts');
      mkdirSync(scriptsDir, { recursive: true });
      cpSync(join(packageRoot, 'skills', 'worktree-dispatcher', 'scripts', 'dispatch.sh'), join(scriptsDir, 'dispatch.sh'));
      results.push({ agent, command: template.name, status: 'installed', path });
    } catch (error) {
      results.push({ agent, command: template.name, status: 'failed', path, reason: errorMessage(error) });
    }
  }
  return results;
}

function claudeCommandFile(template: CommandTemplate): string {
  return `---
description: ${template.description}
argument-hint: <task>
allowed-tools: Bash
---

${template.claudeBody}`;
}

function skillAliasFile(template: CommandTemplate): string {
  return `---
name: ${template.name}
description: ${template.description}
allowed-tools: Bash
---

# ${template.name}

${template.claudeBody}`;
}

function detectCommandAgents(home: string, exists: (path: string) => boolean): CommandAgent[] {
  return (['opencode', 'claude', 'codex', 'pi'] as CommandAgent[]).filter((agent) => {
    if (agent === 'opencode') return exists(join(home, '.config', 'opencode'));
    if (agent === 'claude') return exists(join(home, '.claude'));
    if (agent === 'codex') return exists(join(home, '.codex'));
    return exists(join(home, '.pi', 'agent'));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
