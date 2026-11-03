import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SqliteDatabase } from "../shared/database";
import { agentInput } from "../shared/domain";
import {
  avatarDefinitionSchema,
  defaultAvatarDefinition,
} from "../contract/avatar";
import { botRequests } from "../bot-requests/schema";
import { agents } from "./schema";

function hasStoredAvatar(value: string) {
  try {
    return avatarDefinitionSchema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

const storedProposal = z.looseObject({
  avatar: z.json().optional(),
  avatarDefinition: z.json().optional(),
});

/** Restartable data migration: replace legacy values with fresh defaults, never reconstruct their appearance. */
export const migrateAvatars = Effect.fn("migrateAvatars")(function* (
  db: SqliteDatabase,
) {
  for (const row of yield* db
    .select({ id: agents.id, avatar: agents.avatar })
    .from(agents)) {
    if (hasStoredAvatar(row.avatar)) continue;

    yield* db
      .update(agents)
      .set({ avatar: JSON.stringify(defaultAvatarDefinition(row.id)) })
      .where(and(eq(agents.id, row.id), eq(agents.avatar, row.avatar)));
  }

  // Historical proposals also persist bot inputs. Normalize them before any request is read or approved.
  for (const row of yield* db
    .select({ id: botRequests.id, proposal: botRequests.proposal })
    .from(botRequests)) {
    const proposal = storedProposal.parse(JSON.parse(row.proposal));
    const current = avatarDefinitionSchema.safeParse(proposal.avatar);

    if (current.success && proposal.avatarDefinition === undefined) continue;

    const custom = avatarDefinitionSchema.safeParse(proposal.avatarDefinition);

    const avatar = current.success
      ? current.data
      : custom.success
        ? custom.data
        : defaultAvatarDefinition(row.id);

    yield* db
      .update(botRequests)
      .set({
        proposal: JSON.stringify(agentInput.parse({ ...proposal, avatar })),
      })
      .where(
        and(eq(botRequests.id, row.id), eq(botRequests.proposal, row.proposal)),
      );
  }
});
