import { z } from "zod";
import { contentBlocks } from "@crumble/server/contract/tool-details";
import type { Message } from "./api";

export const blocksOf = (message: Message) =>
  contentBlocks.safeParse(message.blocks).data ?? [];

/** The details of a successful result of one of `tools`; null for any other message or details that don't parse. */
export function toolDetailsOf<S extends z.ZodType>(
  message: Message,
  schema: S,
  ...tools: string[]
): z.output<S> | null {
  if (
    message.role !== "toolResult" ||
    message.isError ||
    !tools.some((tool) => tool === message.toolName)
  )
    return null;

  return schema.safeParse(message.toolDetails).data ?? null;
}
