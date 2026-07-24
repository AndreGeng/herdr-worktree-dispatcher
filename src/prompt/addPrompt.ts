import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { slugify } from '../utils/text.js';

export function writeWorktreePromptFile(worktreePath: string, label: string): string {
  const safeLabel = slugify(label);
  const promptDir = join(worktreePath, '.herdr-worktree-dispatcher');
  mkdirSync(promptDir, { recursive: true });
  addDispatcherDirToExclude(worktreePath);
  return join(promptDir, `PROMPT-${safeLabel}.md`);
}

export function promptCommandPath(worktreePath: string, promptPath: string): string {
  const rel = relative(worktreePath, promptPath);
  return rel.startsWith('..') ? promptPath : rel;
}

export function writeWorktreeRunScript(worktreePath: string, label: string, command: string): string {
  const safeLabel = slugify(label);
  const runDir = join(worktreePath, '.herdr-worktree-dispatcher', 'runs');
  mkdirSync(runDir, { recursive: true });
  addDispatcherDirToExclude(worktreePath);
  const scriptPath = join(runDir, `${safeLabel}.sh`);
  writeFileSync(scriptPath, `#!/bin/sh\n${command}\n`);
  chmodSync(scriptPath, 0o700);
  return scriptPath;
}

export function buildAddPrompt(input: {
  taskText: string;
  language: string;
  mergeInstruction: boolean;
  mergeMode: string;
  sourceCwd: string;
  mergeCommand?: string;
  cleanupLogFile?: string;
}): string {
  let prompt = `You are running inside a git worktree created by the worktree dispatcher.
Do not create further worktrees unless the user explicitly asks from this session.
Do not use Workmux or workmux-specific base selection; use the source checkout and source branch named in this prompt.
The source agent may send follow-up messages through the dispatcher message command; treat those messages as user instructions for this worktree session.
Implement the task directly in this checkout, verify it, and summarize the result.
Every dispatched task must produce a concrete file artifact in this worktree. If the task is implementation, modify the relevant project files. If the task is analysis, review, research, planning, explanation, or otherwise read-only, write the result to an appropriate markdown file in this worktree. Do not only return the content in the TUI unless the user explicitly asks for chat-only output.
If the task asks you to generate, write, create, produce, draft, or output something, create or modify an actual file in this worktree.
Language: use ${input.language} for natural-language summaries and generated human-readable file content. Keep code identifiers, commands, paths, and original error text unchanged.

Task:
${input.taskText}
`;
  if (input.mergeInstruction) {
    prompt += `
When the task is complete, only commit if you changed tracked project files. Do not merge or rebase manually. The dispatcher owns integration back into the source checkout (${input.sourceCwd}) and will use merge mode: ${input.mergeMode} if there is a commit to integrate.
`;
  }
  if (input.mergeCommand) {
    prompt += `
When all requested work is complete, check whether you changed any tracked project files.

If you made changes, verify them, commit only your own changes, then execute this dispatcher merge command as a real shell command via your terminal tool:

    ${input.mergeCommand}

If you did not make any changes or did not create a commit, do not run the merge command and do not clean up the worktree. Leave the agent/worktree open for inspection and report that there was nothing to merge.

This command verifies both checkouts are clean, integrates this worktree branch back into the source checkout, removes the Herdr worktree workspace, and safely deletes the temporary branch. If finalization is not safe, do not run it; report why and provide the exact command for later.

Merge audit log path: ${input.cleanupLogFile || ''}
If that log file does not exist after you claim merge ran, the merge command was not executed.
`;
  }
  return prompt;
}

export function addDispatcherDirToExclude(worktreePath: string): void {
  const gitFile = join(worktreePath, '.git');
  let excludePath = '';
  if (!existsSync(gitFile)) return;
  try {
    const content = readFileSync(gitFile, 'utf8');
    const match = content.match(/^gitdir: (.+)$/m);
    if (match) {
      const gitDir = match[1].startsWith('/') ? match[1] : join(worktreePath, match[1]);
      excludePath = join(dirname(dirname(gitDir)), 'info', 'exclude');
    } else {
      excludePath = join(gitFile, 'info', 'exclude');
    }
  } catch {
    excludePath = join(gitFile, 'info', 'exclude');
  }
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (!existing.split(/\r?\n/).includes('.herdr-worktree-dispatcher/')) {
    writeFileSync(excludePath, `${existing}${existing.endsWith('\n') || !existing ? '' : '\n'}\n# herdr worktree dispatcher prompt files\n.herdr-worktree-dispatcher/\n`);
  }
}
