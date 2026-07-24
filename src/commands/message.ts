import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { agentSend, findAgentTarget, getAgentPaneId, sendToPane } from '../herdr/client.js';
import { readMergeToken } from '../token/token.js';
import { die } from '../utils/errors.js';
import { trimTrailingWhitespace } from '../utils/text.js';

interface MessageOptions {
  token?: string;
  agent?: string;
}

export function registerMessage(program: Command): void {
  program
    .command('message')
    .description('Send a message to a dispatched worker agent')
    .option('--token <path>', 'Lifecycle token path')
    .option('--agent <target>', 'Herdr agent target')
    .argument('[message...]')
    .action((messageParts: string[], options: MessageOptions) => runMessage(messageParts, options));
}

export function runMessage(messageParts: string[], options: MessageOptions): void {
  if (options.token && options.agent) die('use either --token or --agent, not both');
  if (!options.token && !options.agent) die('message requires --token or --agent');
  const messageText = readMessageText(messageParts);
  let herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
  let agentTarget = options.agent || '';
  if (options.token) {
    const token = readMergeToken(options.token);
    herdrBin = token.herdr_bin || herdrBin;
    agentTarget = token.agent_name || findAgentTarget(herdrBin, token.worktree_workspace_id, token.worktree_path) || '';
  }
  if (!agentTarget) die('could not resolve worker agent target');
  const paneId = getAgentPaneId(herdrBin, agentTarget);
  if (paneId) {
    sendToPane(herdrBin, paneId, messageText);
    process.stdout.write(`${JSON.stringify({ status: 'sent', agent: agentTarget, pane_id: paneId, submitted: true })}\n`);
  } else {
    agentSend(herdrBin, agentTarget, messageText);
    process.stdout.write(`${JSON.stringify({ status: 'sent', agent: agentTarget, submitted: false })}\n`);
  }
}

function readMessageText(messageParts: string[]): string {
  let messageText = '';
  if (messageParts.length > 0) messageText = messageParts.join(' ');
  else if (!process.stdin.isTTY) messageText = readFileSync(0, 'utf8');
  else die('message text is required');
  messageText = trimTrailingWhitespace(messageText);
  if (!messageText) die('message text is empty');
  return messageText;
}
