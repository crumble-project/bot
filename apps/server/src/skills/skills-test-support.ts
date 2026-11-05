import { Effect, Layer, ManagedRuntime } from "effect";
import type { ExecutionRepository } from "../bots/execution-repository";
import type { ProductDatabase } from "../shared/product-database";
import type { Runner } from "../shared/runner";
import { CommonSkills, type CommonSkill } from "./common-skills";
import type { SkillRepository } from "./skill-repository";
import { BotSkills } from "./skills";

/** The skills of `store`'s account with `commonSkills` as defaults, for a test without an account. */
export const standaloneSkills = (
  store: {
    runtime: Runner<SkillRepository | ProductDatabase | ExecutionRepository>;
  },
  commonSkills: CommonSkill[] = [],
) =>
  ManagedRuntime.make(
    BotSkills.layer.pipe(
      Layer.provide(Layer.succeed(CommonSkills, commonSkills)),
      Layer.provide(
        Layer.succeedContext(
          store.runtime.runSync(
            Effect.context<
              SkillRepository | ProductDatabase | ExecutionRepository
            >(),
          ),
        ),
      ),
    ),
  ).runSync(BotSkills.use(Effect.succeed));
