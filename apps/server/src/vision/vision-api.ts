import type { Models } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { InvalidInput } from "../shared/errors";
import { SettingsRepository } from "../shared/settings-repository";
import {
  chosenVisionModel,
  VISION_MODEL,
  visionChoices,
  type VisionModelRef,
} from "./vision";

export function registerVisionModelRoutes(options: {
  register: Register<Env, SettingsRepository>;
  providerAuth: { readonly models: Models };
}) {
  const { register } = options;
  const models = options.providerAuth.models;

  const status = Effect.gen(function* () {
    yield* Effect.promise(() => models.refresh());
    const choices = yield* Effect.promise(() => visionChoices(models));

    return {
      visionModel: (yield* chosenVisionModel) ?? null,
      choices: choices.map((model) => ({
        provider: model.provider,
        model: model.id,
        name: model.name,
      })),
    };
  });

  const reachable = Effect.fnUntraced(function* (chosen: VisionModelRef) {
    const choices = yield* Effect.promise(() => visionChoices(models));

    return choices.some(
      (model) =>
        model.provider === chosen.provider && model.id === chosen.model,
    );
  });

  const save = (chosen: VisionModelRef | null) =>
    SettingsRepository.use((settings) =>
      chosen === null
        ? settings.delete(VISION_MODEL)
        : settings.set(VISION_MODEL, chosen),
    );

  register(routes.getVisionModel, function* (c) {
    return c.json(yield* status, 200);
  });
  register(routes.updateVisionModel, function* (c) {
    const { visionModel } = c.req.valid("json");

    if (visionModel && !(yield* reachable(visionModel)))
      return yield* Effect.fail(
        new InvalidInput({
          message: `${visionModel.provider}/${visionModel.model} is not a model that reads images and your provider keys reach`,
        }),
      );

    yield* save(visionModel);

    return c.json(yield* status, 200);
  });
}
