import { z } from "zod";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { reasoningPreviewInput } from "../contract/reasoning";
import { THINKING_LEVELS } from "../contract/agents";
import { routes, providerLoginAnswerInput } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { ExternalAuth } from "../plugins/plugins";
import {
  Conflict,
  InvalidInput,
  NotFound,
  Unavailable,
} from "../shared/errors";
import { readsImages } from "../vision/vision";
import { loginMethods } from "./provider-auth";
import type { ProviderSignInsAccess } from "./provider-auth";
import { normalizeSomaUrl } from "./soma/client";

export function previewReasoning(
  model: Model<Api> | undefined,
  level: z.output<typeof reasoningPreviewInput>["thinkingLevel"],
) {
  const levels = model ? getSupportedThinkingLevels(model) : THINKING_LEVELS;

  const labels = {
    off: "Off",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Maximum",
  };

  return {
    options: levels.map((value) => ({ value, label: labels[value] })),
    effectiveLevel: model ? clampThinkingLevel(model, level) : level,
  };
}

type ProviderRoutesOptions = {
  register: Register;
  providerAuth: ProviderSignInsAccess;
  externalAuth: ReadonlyMap<string, () => Promise<ExternalAuth>>;
  requiresBaseUrl?: ReadonlySet<string>;
};

export const providerSchema = (models: Models) =>
  z
    .string()
    .refine((value) => Boolean(models.getProvider(value)), "Unknown provider");

const availableModels = async (models: Models, name: string | undefined) => {
  await models.refresh(name ? { providers: [name] } : {});

  try {
    return await models.getAvailable(name);
  } catch {
    throw new Unavailable({
      message: "Provider credentials could not be read",
    });
  }
};

const registerProviderStatusRoutes = (options: ProviderRoutesOptions) => {
  const { register, providerAuth } = options;
  const models = providerAuth.models;
  const provider = providerSchema(models);

  register.plain(routes.providers, async (c) =>
    c.json(
      await Promise.all(
        models.getProviders().map(async (item) => ({
          provider: item.id,
          name: item.name,
          configured: Boolean(await models.checkAuth(item.id).catch(() => {})),
          authMethods: loginMethods(item),
          ...providerAuth.status(item.id),
          requiresBaseUrl: options.requiresBaseUrl?.has(item.id) ?? false,
          activeLoginId: providerAuth.activeLoginId(item.id),
          externalAuth: (await options.externalAuth.get(item.id)?.()) ?? null,
        })),
      ),
      200,
    ),
  );
  register.plain(routes.previewReasoning, (c) => {
    const input = c.req.valid("json");
    const model = models.getModel(input.provider, input.model);

    return c.json(previewReasoning(model, input.thinkingLevel), 200);
  });
  register.plain(routes.models, async (c) => {
    const name = c.req.query("provider");

    if (name) {
      provider.parse(name);
    }

    return c.json(
      (await availableModels(models, name)).map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
        images: readsImages(model),
      })),
      200,
    );
  });
};

const registerProviderCredentialRoutes = (options: ProviderRoutesOptions) => {
  const { register, providerAuth } = options;
  const provider = providerSchema(providerAuth.models);

  register.plain(routes.putProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));
    const input = c.req.valid("json");
    const needsBaseUrl = options.requiresBaseUrl?.has(name) ?? false;
    const key =
      input.value !== undefined
        ? { value: input.value }
        : input.reference !== undefined
          ? { reference: input.reference }
          : undefined;

    if (!needsBaseUrl) {
      if (input.baseUrl !== undefined) {
        throw new InvalidInput({
          message: "This provider does not accept a server URL",
        });
      }

      if (!key) {
        throw new InvalidInput({
          message: "Send exactly one of value or reference",
        });
      }

      await providerAuth.setApiKey(name, key);

      return c.json({ provider: name, configured: true }, 200);
    }

    const existing = providerAuth.status(name);
    let normalizedUrl: string | undefined;

    if (input.baseUrl !== undefined) {
      normalizedUrl = normalizeSomaUrl(input.baseUrl);

      if (!normalizedUrl) {
        throw new InvalidInput({
          message:
            "Enter a valid http(s) server URL without credentials, query, or fragment",
        });
      }
    }

    const effectiveUrl = normalizedUrl ?? existing.baseUrl ?? undefined;

    if (!effectiveUrl) {
      throw new InvalidInput({ message: "Server URL is required" });
    }

    if (!key && !existing.apiKey.configured) {
      throw new InvalidInput({ message: "API key is required" });
    }

    await providerAuth.setApiKey(name, key, effectiveUrl);

    return c.json({ provider: name, configured: true }, 200);
  });
  register.plain(routes.deleteProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));
    const external = await options.externalAuth.get(name)?.();

    if (external) {
      throw new Conflict({
        message: `This provider signs in outside Crumble. Sign out on the server: ${external.signOutCommand ?? "see its documentation"}`,
      });
    }

    await providerAuth.signOut(name);

    return c.body(null, 204);
  });
};

const registerProviderLoginRoutes = (options: ProviderRoutesOptions) => {
  const { register, providerAuth } = options;
  const models = providerAuth.models;

  register.plain(routes.startProviderLogin, (c) => {
    const name = c.req.param("provider");

    if (!models.getProvider(name)) {
      throw new NotFound({ message: "Unknown provider" });
    }

    return c.json(providerAuth.start(name, c.req.valid("json").method), 202);
  });
  register.plain(routes.getProviderLogin, (c) =>
    c.json(providerAuth.get(c.req.param("id")), 200),
  );
  register.plain(
    routes.answerProviderLogin,
    async (c) => {
      const input = providerLoginAnswerInput.safeParse(await c.req.json());

      if (!input.success) {
        throw new InvalidInput({ message: "Invalid answer" });
      }

      return c.json(
        providerAuth.answer(
          c.req.param("id"),
          input.data.promptId,
          input.data.value,
        ),
        200,
      );
    },
    { parsesBody: true },
  );
  register.plain(routes.cancelProviderLogin, (c) =>
    c.json(providerAuth.cancel(c.req.param("id")), 200),
  );
};

export function registerProviderRoutes(options: ProviderRoutesOptions) {
  registerProviderStatusRoutes(options);
  registerProviderCredentialRoutes(options);
  registerProviderLoginRoutes(options);
}
