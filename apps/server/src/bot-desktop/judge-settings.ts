import { isModelType, type AnyModel, type Models } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { judgeModelInput } from "../contract/agents";
import { InvalidInput } from "../shared/errors";
import { SettingsRepository } from "../shared/settings-repository";
import {
  judgeChoices,
  judgeModel,
  sameRef,
  type JudgeModelRef,
} from "./intent-judge";

const JUDGE_MODEL = "desktop:judge-model";

const stored = judgeModelInput.shape.judgeModel
  .unwrap()
  .optional()
  .catch(undefined);

export const chosenJudge = SettingsRepository.use((r) =>
  r.get(JUDGE_MODEL),
).pipe(Effect.map((value): JudgeModelRef | undefined => stored.parse(value)));

const choiceOf = (model: AnyModel) => ({
  provider: model.provider,
  model: model.id,
  name: model.name,
  kind: isModelType(model, "classifier")
    ? ("classifier" as const)
    : ("chat" as const),
});

export function registerJudgeModelRoutes(options: {
  register: Register<Env, SettingsRepository>;
  models: Models;
}) {
  const { register, models } = options;

  const status = Effect.gen(function* () {
    yield* Effect.promise(() => models.refresh());
    const judgeModelRef = yield* chosenJudge;

    const effective = yield* Effect.promise(() =>
      judgeModel(models, judgeModelRef),
    );

    const choices = yield* Effect.promise(() => judgeChoices(models));

    return {
      judgeModel: judgeModelRef ?? null,
      effective: effective ? choiceOf(effective) : null,
      choices: choices.map(choiceOf),
    };
  });

  register(routes.getJudgeModel, function* (c) {
    return c.json(yield* status, 200);
  });
  register(routes.updateJudgeModel, function* (c) {
    const { judgeModel: chosen } = c.req.valid("json");
    const choices = yield* Effect.promise(() => judgeChoices(models));

    if (chosen && !choices.some((model) => sameRef(model, chosen)))
      return yield* Effect.fail(
        new InvalidInput({
          message: `${chosen.provider}/${chosen.model} is not a classifier model your provider keys reach`,
        }),
      );

    yield* SettingsRepository.use((r) =>
      chosen ? r.set(JUDGE_MODEL, chosen) : r.delete(JUDGE_MODEL),
    );

    return c.json(yield* status, 200);
  });
}
