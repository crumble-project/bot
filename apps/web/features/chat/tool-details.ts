import type { z } from "zod";
import type { Message } from "./api";

export const blocksOf = (message: Message) => message.blocks ?? [];

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
