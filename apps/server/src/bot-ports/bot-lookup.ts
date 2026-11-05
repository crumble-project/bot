import type { Agent } from "../contract/agents";

export type BotLookup = { readonly agent: (agentId: string) => Agent };
