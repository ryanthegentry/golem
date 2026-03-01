import type { BotContext, CommandResult } from '../types.js';
import { formatStatus } from '../formatter.js';

export async function handleStatus(ctx: BotContext): Promise<CommandResult> {
  const [balance, vtxos] = await Promise.all([
    ctx.wallet.getBalance(),
    ctx.wallet.getVtxos(),
  ]);

  const agentStatus = ctx.getAgentStatus();

  return {
    text: formatStatus(balance, vtxos, agentStatus, ctx.networkConfig),
    parseMode: 'MarkdownV2',
  };
}
