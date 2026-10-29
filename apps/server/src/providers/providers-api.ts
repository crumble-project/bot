import { z } from "zod";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import {
  routes,
  providerKeyInput,
  providerLoginAnswerInput,
  providerLoginInput,
} from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { ExternalAuth } from "../plugins/plugins";
import {
  Conflict,
  InvalidInput,
  NotFound,
  Unavailable,
} from "../shared/errors";
import type { Runner } from "../shared/runner";
import { loginMethods, type ProviderSignInsAccess } from "./provider-auth";
import { ProviderCredentialRepository } from "./provider-credential-repository";

type Services = ProviderCredentialRepository;

type Exec = Runner<Services>["runSync"];

type ProviderRoutesOptions = {
  register: Register;
  providerAuth: ProviderSignInsAccess;
  /** Runs the repository effects the provider routes read. */
  run: Runner<Services>;
  /** Providers whose sign-in happens outside Crumble, by provider ID. */
  externalAuth?: ReadonlyMap<string, () => Promise<ExternalAuth>>;
};

/** The providers this server can serve; a saved credential may name a provider that has since been dropped. */
export const providerSchema = (models: Models) =>
  z
    .string()
    .refine((value) => Boolean(models.getProvider(value)), "Unknown provider");

/** Dynamic providers list their models only after a refresh with the saved credential. */
const availableModels = async (models: Models, name: string | undefined) => {
  await models.refresh(name ? { providers: [name] } : {});

  try {
    return await models.getAvailable(name);
  } catch {
    // Pi AI errors can carry provider responses; keep them out of logs and clients.
    throw new Unavailable({
      message: "Provider credentials could not be read",
    });
  }
};

/** Each provider's sign-in state, and the models its credentials can reach. */
const registerProviderStatusRoutes = (options: ProviderRoutesOptions) => {
  const { register, providerAuth } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);
  const models = providerAuth.models;
  const provider = providerSchema(models);

  register(routes.providers, async (c) => {
    const saved = new Map(
      exec(ProviderCredentialRepository.use((r) => r.list)).map((info) => [
        info.providerId,
        info,
      ]),
    );

    return c.json(
      await Promise.all(
        models.getProviders().map(async (item) => ({
          provider: item.id,
          name: item.name,
          configured: Boolean(
            await models.checkAuth(item.id).catch(() => undefined),
          ),
          authMethods: loginMethods(item),
          credentialType: saved.get(item.id)?.type ?? null,
          passwordManager: saved.get(item.id)?.passwordManager ?? null,
          reference: saved.get(item.id)?.reference ?? null,
          activeLoginId: providerAuth.activeLoginId(item.id),
          externalAuth: (await options.externalAuth?.get(item.id)?.()) ?? null,
        })),
      ),
      200,
    );
  });
  register(routes.models, async (c) => {
    const name = c.req.query("provider");

    if (name) provider.parse(name);

    return c.json(
      (await availableModels(models, name)).map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
        thinkingLevels: getSupportedThinkingLevels(model),
      })),
      200,
    );
  });
};

/** Storing and removing one provider's API key. */
const registerProviderCredentialRoutes = (options: ProviderRoutesOptions) => {
  const { register, providerAuth } = options;
  const provider = providerSchema(providerAuth.models);

  register(routes.putProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));

    const input = providerKeyInput.parse(await c.req.json());

    if (input.reference) await providerAuth.setReference(name, input.reference);
    else if (input.apiKey) await providerAuth.setApiKey(name, input.apiKey);

    return c.json({ provider: name, configured: true }, 200);
  });
  register(routes.deleteProvider, async (c) => {
    const name = provider.parse(c.req.param("provider"));
    const external = await options.externalAuth?.get(name)?.();

    if (external)
      throw new Conflict({
        message: `This provider signs in outside Crumble. Sign out on the server: ${external.signOutCommand ?? "see its documentation"}`,
      });

    await providerAuth.signOut(name);

    return c.body(null, 204);
  });
};

/** The interactive sign-in flow: starting one, following it, answering its prompts, and cancelling it. */
const registerProviderLoginRoutes = (options: ProviderRoutesOptions) => {
  const { register, providerAuth } = options;
  const models = providerAuth.models;

  register(routes.startProviderLogin, async (c) => {
    const name = c.req.param("provider");

    if (!models.getProvider(name))
      throw new NotFound({ message: "Unknown provider" });
    const input = providerLoginInput.parse(await c.req.json());

    return c.json(providerAuth.start(name, input.method), 202);
  });
  register(routes.getProviderLogin, (c) =>
    c.json(providerAuth.get(c.req.param("id")), 200),
  );
  register(routes.answerProviderLogin, async (c) => {
    const input = providerLoginAnswerInput.safeParse(await c.req.json());

    // Answers can be secrets or callback URLs; never echo them in validation details.
    if (!input.success) throw new InvalidInput({ message: "Invalid answer" });

    return c.json(
      providerAuth.answer(
        c.req.param("id"),
        input.data.promptId,
        input.data.value,
      ),
      200,
    );
  });
  register(routes.cancelProviderLogin, (c) =>
    c.json(providerAuth.cancel(c.req.param("id")), 200),
  );
};

/** The provider routes, in the order the contract document lists them. */
export function registerProviderRoutes(options: ProviderRoutesOptions) {
  registerProviderStatusRoutes(options);
  registerProviderCredentialRoutes(options);
  registerProviderLoginRoutes(options);
}
