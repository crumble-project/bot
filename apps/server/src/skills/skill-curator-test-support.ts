import { Effect, Layer, ManagedRuntime } from "effect";
import type { ScheduleRepository } from "../automations/schedule-repository";
import type { Runner } from "../shared/runner";
import { SkillCurator } from "./skill-curator";
import type { SkillRepository } from "./skill-repository";

/** One curation pass over `store`'s account as of `now`, for a test without an account. */
export const curateNow = (
  store: { runtime: Runner<SkillRepository | ScheduleRepository> },
  now: Date,
) =>
  ManagedRuntime.make(
    SkillCurator.layer.pipe(
      Layer.provide(
        Layer.succeedContext(
          store.runtime.runSync(
            Effect.context<SkillRepository | ScheduleRepository>(),
          ),
        ),
      ),
    ),
  ).runSync(SkillCurator.use((curator) => curator.pass(now)));
