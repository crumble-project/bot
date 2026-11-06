import { z } from "zod";
import {
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_CHARS,
  MIN_GROUP_MEMBERS,
} from "../shared/limits";

export const groupChatInput = z.object({
  name: z.string().trim().min(1).max(MAX_GROUP_NAME_CHARS),
  memberIds: z
    .array(z.uuid())
    .min(MIN_GROUP_MEMBERS)
    .max(MAX_GROUP_MEMBERS)
    .refine((ids) => new Set(ids).size === ids.length, "List each bot once"),
});
