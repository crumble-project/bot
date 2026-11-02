import { z } from "@hono/zod-openapi";
import { DEFAULT_COLOR, DEFAULT_EYE_COLOR, examples } from "open-bot-avatar";
import { avatarDefinitionSchema as persistedAvatar } from "../shared/avatar-definition";

/** Named transport contract, derived from the same fields and validator as persisted input. */
export const avatarDefinitionSchema = z
  .object(persistedAvatar.shape)
  .openapi("BotAvatarDefinition");

export type BotAvatarDefinition = z.infer<typeof avatarDefinitionSchema>;

/** Fresh gallery geometry and library colors, selected only by bot ID, never its legacy avatar string. */
export function defaultAvatarDefinition(botId: string): BotAvatarDefinition {
  let hash = 0;

  for (const character of botId)
    hash = (Math.imul(hash, 31) + character.codePointAt(0)!) >>> 0;

  return {
    definition: examples[hash % examples.length]!,
    color: DEFAULT_COLOR,
    eyeColor: DEFAULT_EYE_COLOR,
  };
}
