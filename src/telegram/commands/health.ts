import type { BotContext, CommandResult } from '../types.js';
import { formatHealth } from '../formatter.js';

export async function handleHealth(
  ctx: BotContext,
  lastAlertTime: string | null,
): Promise<CommandResult> {
  const [balance, vtxos] = await Promise.all([
    ctx.wallet.getBalance(),
    ctx.wallet.getVtxos(),
  ]);

  const agentStatus = ctx.getAgentStatus();

  return {
    text: formatHealth(balance, vtxos.length, agentStatus, lastAlertTime),
    parseMode: 'MarkdownV2',
  };
}
