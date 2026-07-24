import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SkillAgent = 'opencode' | 'claude' | 'codex' | 'pi';

export const skillTargetRoots: Record<SkillAgent, string> = {
  opencode: '~/.config/opencode/skills',
  claude: '~/.claude/skills',
  codex: '~/.codex/skills',
  pi: '~/.pi/agent/skills',
};

const detectionRoots: Record<SkillAgent, string> = {
  opencode: '~/.config/opencode',
  claude: '~/.claude',
  codex: '~/.codex',
  pi: '~/.pi/agent',
};

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function parseSkillAgent(value: string): SkillAgent | 'all' {
  if (value === 'opencode' || value === 'claude' || value === 'codex' || value === 'pi' || value === 'all') return value;
  throw new Error(`invalid --agent value: ${value} (expected opencode, claude, codex, pi, or all)`);
}

export function resolveSkillRoots(input: {
  agents: Array<SkillAgent | 'all'>;
  customSkillDirs: string[];
  exists?: (path: string) => boolean;
}): Array<{ agent: SkillAgent | 'custom'; root: string; detected: boolean }> {
  const exists = input.exists ?? existsSync;
  const roots: Array<{ agent: SkillAgent | 'custom'; root: string; detected: boolean }> = [];
  const seen = new Set<string>();

  for (const customDir of input.customSkillDirs) {
    const root = expandHome(customDir);
    if (!seen.has(root)) {
      roots.push({ agent: 'custom', root, detected: true });
      seen.add(root);
    }
  }

  const agents = input.agents.length > 0 ? input.agents : detectAgents(exists);
  const expandedAgents = agents.includes('all') ? (['opencode', 'claude', 'codex', 'pi'] as SkillAgent[]) : (agents as SkillAgent[]);
  for (const agent of expandedAgents) {
    const root = expandHome(skillTargetRoots[agent]);
    if (!seen.has(root)) {
      roots.push({ agent, root, detected: agents.length > 0 || exists(expandHome(detectionRoots[agent])) });
      seen.add(root);
    }
  }
  return roots;
}

function detectAgents(exists: (path: string) => boolean): SkillAgent[] {
  return (Object.keys(detectionRoots) as SkillAgent[]).filter((agent) => exists(expandHome(detectionRoots[agent])));
}
