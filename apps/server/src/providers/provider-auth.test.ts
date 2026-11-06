import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProvider,
  envApiKeyAuth,
  type OAuthAuth,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { Effect, Exit, Layer, Scope } from "effect";
import { until } from "../../test/support/until";
import { productLayer } from "../app/product-layer";
import { secretsLayer } from "../secrets/secrets";
import { runnerOf } from "../shared/runner";
import { standaloneSignIns } from "./provider-auth-test-support";
import { ProviderCredentials } from "./provider-credentials";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const failedLogin = async (failure: Error) => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-provider-auth-"));
  const scope = Scope.makeUnsafe();

  cleanups.push(() => {
    Effect.runSync(Scope.close(scope, Exit.void));
    rmSync(dir, { recursive: true, force: true });
  });

  const context = Effect.runSync(
    Layer.buildWithScope(
      ProviderCredentials.layer.pipe(
        Layer.provideMerge(secretsLayer([])),
        Layer.provideMerge(productLayer(dir)),
      ),
      scope,
    ),
  );

  const oauth: OAuthAuth = {
    name: "Failing",
    login: () => Promise.reject(failure),
    refresh: (credential) => Promise.resolve(credential),
    toAuth: () => Promise.reject(new Error("no auth")),
  };

  const provider = createProvider<"openai-completions">({
    id: "failing",
    name: "Failing",
    baseUrl: "https://failing.example",
    auth: { apiKey: envApiKeyAuth("Failing key", []), oauth },
    models: [],
    api: openAICompletionsApi(),
  });

  const signIns = standaloneSignIns(runnerOf(context), [{ provider }]);
  const { id } = signIns.start("failing", "oauth");

  await until(() => signIns.get(id).status !== "pending");

  return signIns.get(id).failure?.code;
};

const addressInUse = () =>
  Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });

describe("callback port conflicts", () => {
  test("recognizes the system's address-in-use error", async () => {
    expect(await failedLogin(addressInUse())).toBe("callback_unavailable");
  });

  test("recognizes a provider message that names the port", async () => {
    expect(
      await failedLogin(
        new Error("Failed to start server: port 1455 is in use"),
      ),
    ).toBe("callback_unavailable");
  });

  test("follows the cause chain to the error that carries the conflict", async () => {
    const wrapped = new Error("Login failed", {
      cause: new Error("Callback server failed", { cause: addressInUse() }),
    });

    expect(await failedLogin(wrapped)).toBe("callback_unavailable");
  });

  test("reports other failures as provider failures", async () => {
    expect(await failedLogin(new Error("invalid_grant"))).toBe(
      "provider_failure",
    );
    expect(
      await failedLogin(new Error("Login failed", { cause: "offline" })),
    ).toBe("provider_failure");
  });
});
