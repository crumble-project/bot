import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import type { ProductDatabase } from "../shared/product-database";
import type { Runner } from "../shared/runner";
import { DefaultSkills, type DefaultSkill } from "./default-skills";
import { OwnerSkills } from "./owner-skills";
import type { SkillInstaller } from "./skill-installer";
import type { SkillRepository } from "./skill-repository";
import { BotSkills } from "./skills";

export const standaloneSkills = (
  store: {
    runtime: Runner<SkillRepository | ProductDatabase | ExecutionRepository>;
  },
  defaultSkills: DefaultSkill[] = [],
) =>
  ManagedRuntime.make(
    BotSkills.layer.pipe(
      Layer.provide(Layer.succeed(DefaultSkills, defaultSkills)),
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

type OwnerServices =
  | AgentRepository
  | ProductDatabase
  | SkillInstaller
  | SkillRepository;

export const standaloneOwnerSkills = (
  store: { runtime: Runner<OwnerServices> },
  defaultSkills: DefaultSkill[] = [],
) =>
  ManagedRuntime.make(
    OwnerSkills.layer.pipe(
      Layer.provide(Layer.succeed(DefaultSkills, defaultSkills)),
      Layer.provide(
        Layer.succeedContext(
          store.runtime.runSync(Effect.context<OwnerServices>()),
        ),
      ),
    ),
  ).runSync(OwnerSkills.use(Effect.succeed));
