import { promptCommandPath } from '../prompt/addPrompt.js';
import { firstCommandToken, shellQuote } from '../utils/process.js';

export interface AgentRunCommandInput {
  agentCommand: string;
  agentArgs?: string[];
  cwd: string;
  promptPath: string;
  traceEnv: string;
  forceInteractive?: boolean;
  codexSafeAutomation?: boolean;
  codexWritableDirs?: string[];
  shellExec?: boolean;
}

export interface AgentRunCommand {
  command: string;
  needsPanePrompt: boolean;
}

export function buildAgentRunCommand(input: AgentRunCommandInput): AgentRunCommand {
  const agentArgs = input.agentArgs || [];
  const executable = firstCommandToken(input.agentCommand);
  const promptPathForCommand = shellQuote(promptCommandPath(input.cwd, input.promptPath));
  const quotedArgs = agentArgs.map(shellQuote).join(' ');
  const suffix = quotedArgs ? ` ${quotedArgs}` : '';
  const prefix = input.shellExec === false ? input.traceEnv : `${input.traceEnv} exec`;

  if (input.forceInteractive) {
    if (executable === 'opencode') {
      return { command: `${prefix} ${input.agentCommand} --prompt "$(cat ${promptPathForCommand})"${suffix}`, needsPanePrompt: false };
    }
    if (executable === 'codex') {
      if (input.codexSafeAutomation) {
        const codexArgs = withCodexSafeAutomationDefaults(input.agentCommand, agentArgs, input.codexWritableDirs || []).map(shellQuote).join(' ');
        const codexOptions = codexArgs ? ` ${codexArgs}` : '';
        return { command: `${prefix} ${input.agentCommand}${codexOptions} "$(cat ${promptPathForCommand})"`, needsPanePrompt: false };
      }
      return { command: `${prefix} ${input.agentCommand} "$(cat ${promptPathForCommand})"${suffix}`, needsPanePrompt: false };
    }
    return { command: `${prefix} ${input.agentCommand}${suffix}`, needsPanePrompt: true };
  }

  if (executable === 'opencode') {
    return { command: `${prefix} ${input.agentCommand} run --format default --dangerously-skip-permissions "$(cat ${promptPathForCommand})"${suffix}`, needsPanePrompt: false };
  }
  if (executable === 'codex') {
    return { command: `${prefix} ${input.agentCommand} exec --dangerously-bypass-approvals-and-sandbox --color always "$(cat ${promptPathForCommand})"${suffix}`, needsPanePrompt: false };
  }
  if (executable === 'pi') {
    return { command: `${prefix} ${input.agentCommand} -p --mode json "$(cat ${promptPathForCommand})"${suffix}`, needsPanePrompt: false };
  }
  if (executable === 'claude') {
    return { command: `${prefix} ${input.agentCommand} -p "$(cat ${promptPathForCommand})" --output-format text --no-session-persistence --dangerously-skip-permissions${suffix}`, needsPanePrompt: false };
  }

  return { command: `${prefix} ${input.agentCommand}${suffix}`, needsPanePrompt: true };
}

function withCodexSafeAutomationDefaults(agentCommand: string, agentArgs: string[], writableDirs: string[]): string[] {
  const tokens = [...splitShellWords(agentCommand), ...agentArgs];
  const bypassesApprovalAndSandbox = tokens.includes('--dangerously-bypass-approvals-and-sandbox');
  const hasApproval = bypassesApprovalAndSandbox
    || hasOption(tokens, '-a', '--ask-for-approval')
    || hasConfigValue(tokens, 'approval_policy');
  const sandboxMode = resolveSandboxMode(tokens);
  const hasSandbox = bypassesApprovalAndSandbox || sandboxMode !== undefined;
  const hasHookTrust = tokens.includes('--dangerously-bypass-hook-trust');
  const defaults: string[] = [];

  if (!hasApproval) defaults.push('-a', 'never');
  if (!hasSandbox) defaults.push('-s', 'workspace-write');
  if (!hasHookTrust) defaults.push('--dangerously-bypass-hook-trust');
  if (!bypassesApprovalAndSandbox && (sandboxMode === undefined || sandboxMode === 'workspace-write')) {
    for (const directory of writableDirs) defaults.push('--add-dir', directory);
  }
  return [...defaults, ...agentArgs];
}

function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) words.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) words.push(current);
  return words;
}

function hasOption(tokens: string[], shortOption: string, longOption: string): boolean {
  return tokens.some((token) => token === shortOption || token === longOption || token.startsWith(`${shortOption}=`) || token.startsWith(`${longOption}=`));
}

function hasConfigValue(tokens: string[], key: string): boolean {
  return configValues(tokens, key).length > 0;
}

function resolveSandboxMode(tokens: string[]): string | undefined {
  let mode: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-s' || token === '--sandbox') mode = tokens[index + 1];
    else if (token.startsWith('-s=')) mode = token.slice('-s='.length);
    else if (token.startsWith('--sandbox=')) mode = token.slice('--sandbox='.length);
    const configured = configValueAt(tokens, index, 'sandbox_mode');
    if (configured !== undefined) mode = configured;
  }
  return mode;
}

function configValues(tokens: string[], key: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const value = configValueAt(tokens, index, key);
    if (value !== undefined) values.push(value);
  }
  return values;
}

function configValueAt(tokens: string[], index: number, key: string): string | undefined {
  const token = tokens[index];
  let candidate = token;
  if (token === '-c' || token === '--config') candidate = tokens[index + 1];
  else if (token.startsWith('-c=')) candidate = token.slice('-c='.length);
  else if (token.startsWith('--config=')) candidate = token.slice('--config='.length);
  const match = candidate?.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
  return match ? match[1].replace(/^["']|["']$/g, '') : undefined;
}
