import type { Models } from "@earendil-works/pi-ai";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { InvalidInput } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import {
  chosenVisionModel,
  VISION_MODEL,
  visionChoices,
  type VisionModelRef,
} from "./vision";

/** The account's vision model: the owner's choice, and every model that could read images for bots. */
export function registerVisionModelRoutes(options: {
  register: Register;
  run: Runner<SettingsRepository>;
  providerAuth: { readonly models: Models };
}) {
  const { register, run } = options;
  const models = options.providerAuth.models;

  const status = async () => {
    await models.refresh();

    return {
      visionModel: run.runSync(chosenVisionModel) ?? null,
      choices: (await visionChoices(models)).map((model) => ({
        provider: model.provider,
        model: model.id,
        name: model.name,
      })),
    };
  };

  // Only a model the account's keys reach and that reads images may describe them.
  const reachable = async (chosen: VisionModelRef) =>
    (await visionChoices(models)).some(
      (model) =>
        model.provider === chosen.provider && model.id === chosen.model,
    );

  const save = (chosen: VisionModelRef | null) =>
    SettingsRepository.use((settings) =>
      chosen === null
        ? settings.delete(VISION_MODEL)
        : settings.set(VISION_MODEL, chosen),
    );

  register(routes.getVisionModel, async (c) => c.json(await status(), 200));
  register(routes.updateVisionModel, async (c) => {
    const { visionModel } = c.req.valid("json");

    if (visionModel && !(await reachable(visionModel)))
      throw new InvalidInput({
        message: `${visionModel.provider}/${visionModel.model} is not a model that reads images and your provider keys reach`,
      });

    run.runSync(save(visionModel));

    return c.json(await status(), 200);
  });
}
