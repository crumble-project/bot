import { isModelType, type AnyModel, type Models } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { judgeModelInput } from "../contract/agents";
import { InvalidInput } from "../shared/errors";
import type { Runner } from "../shared/runner";
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

/** The judge model the owner chose; undefined means the default. */
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

/** The account's judge model: the owner's choice, the model judging now, and every model that could. */
export function registerJudgeModelRoutes(options: {
  register: Register;
  run: Runner<SettingsRepository>;
  models: Models;
}) {
  const { register, run, models } = options;

  const status = async () => {
    await models.refresh();
    const judgeModelRef = run.runSync(chosenJudge);
    const effective = await judgeModel(models, judgeModelRef);

    return {
      judgeModel: judgeModelRef ?? null,
      effective: effective ? choiceOf(effective) : null,
      choices: (await judgeChoices(models)).map(choiceOf),
    };
  };

  register(routes.getJudgeModel, async (c) => c.json(await status(), 200));
  register(routes.updateJudgeModel, async (c) => {
    const { judgeModel: chosen } = c.req.valid("json");

    if (
      chosen &&
      !(await judgeChoices(models)).some((model) => sameRef(model, chosen))
    )
      throw new InvalidInput({
        message: `${chosen.provider}/${chosen.model} is not a classifier model your provider keys reach`,
      });

    run.runSync(
      SettingsRepository.use((r) =>
        chosen ? r.set(JUDGE_MODEL, chosen) : r.delete(JUDGE_MODEL),
      ),
    );

    return c.json(await status(), 200);
  });
}
