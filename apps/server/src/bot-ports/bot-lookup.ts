import type { Agent } from "../contract/agents";

/** What a feature's routes ask of the bots: the bot of an ID, or a 404. */
export type BotLookup = { readonly agent: (agentId: string) => Agent };
