import type { Effect } from "effect";
import { Context } from "effect";

type InlineSkill = { name: string; instructions: string };

export class AgentSkills extends Context.Service<
  AgentSkills,
  {
    readonly list: (agentId: string) => Effect.Effect<InlineSkill[]>;
    readonly replace: (
      agentId: string,
      skills: ReadonlyArray<InlineSkill>,
    ) => Effect.Effect<void>;
  }
>()("crumble/bot-store/AgentSkills") {}
