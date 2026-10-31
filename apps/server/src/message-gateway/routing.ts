import type { GatewayMessage } from "./adapter";
import {
  normalizeGatewayHandle,
  type GatewayConfig,
} from "../contract/message-gateway";

export type GatewayBot = { id: string; name: string; enabled: boolean };

export const authorizedMessage = (
  config: GatewayConfig,
  message: GatewayMessage,
) =>
  config.enabled &&
  config.ownerId !== null &&
  config.ownerId === message.senderId &&
  (message.isDirectMessage
    ? config.allowDirectMessages
    : config.allowedChannelIds.includes(message.channelId));

export function selectGatewayBot(
  config: GatewayConfig,
  text: string,
  bots: readonly GatewayBot[],
  replyBotId: string | null,
): GatewayBot {
  const prefix = /^\s*@([^\s]+)(?:\s|$)/u.exec(text)?.[1];
  let selected: GatewayBot | undefined;

  if (prefix) {
    const alias = config.aliases.find(
      (entry) =>
        normalizeGatewayHandle(entry.handle) === normalizeGatewayHandle(prefix),
    );

    if (alias) selected = bots.find((bot) => bot.id === alias.botId);
    else {
      const input = normalizeGatewayHandle(text.trimStart());

      const candidates = bots.filter((bot) => {
        const name = `@${normalizeGatewayHandle(bot.name)}`;

        return (
          input.startsWith(name) &&
          (input.length === name.length || /\s/u.test(input[name.length]!))
        );
      });

      const length = Math.max(
        ...candidates.map((bot) => normalizeGatewayHandle(bot.name).length),
      );

      const matches = candidates.filter(
        (bot) => normalizeGatewayHandle(bot.name).length === length,
      );

      if (matches.length === 1) selected = matches[0];
    }
  } else
    selected = bots.find(
      (bot) => bot.id === (replyBotId ?? config.defaultBotId),
    );

  if (!selected)
    throw new Error(
      prefix
        ? `Unknown or ambiguous bot @${prefix}. Configure an alias in Message gateways.`
        : "No recipient is configured. Choose a default bot or use @handle.",
    );

  if (!selected.enabled)
    throw new Error(
      `Bot ${selected.name} is disabled. Enable it before sending messages.`,
    );

  return selected;
}

export function gatewayChunks(text: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 2)
    throw new Error("Invalid adapter message limit");
  const chunks: string[] = [];
  let chunk = "";

  for (const character of text) {
    if (chunk.length + character.length > maxLength) {
      chunks.push(chunk);
      chunk = "";
    }

    chunk += character;
  }

  if (chunk) chunks.push(chunk);

  return chunks;
}
