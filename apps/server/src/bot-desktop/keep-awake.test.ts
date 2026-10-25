import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Store } from "../../test/support/store";
import { AgentRepository } from "../bots/agent-repository";
import { agentInput } from "../shared/domain";
import { BotWorkspaces, type Workspaces } from "../workspaces/workspace";
import { DesktopControl, desktopControlAccess } from "./desktop-control";
import { desktopKeepAwake } from "./keep-awake";

test("owner holds survive control updates and release when the keep-awake scope closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "crumble-keep-awake-"));
  const store = new Store(directory);
  const agent = store.createAgent(agentInput.parse({ name: "Desktop" }));
  const control = desktopControlAccess(store.runtime);
  let holds = 0;

  const workspaces: Workspaces = {
    desktop: true,
    env: () => Effect.die("No environment in this test"),
    restart: () => Effect.void,
    openDesktop: () => Effect.die("No stream in this test"),
    startDesktop: () => Effect.void,
    keepAwake: () =>
      Effect.sync(() => {
        holds += 1;

        return () => {
          holds -= 1;
        };
      }),
    sync: () => Effect.void,
    close: () => Effect.void,
  };

  control.set(agent.id, "owner");

  const runtime = ManagedRuntime.make(
    desktopKeepAwake.pipe(
      Layer.provide(Layer.succeed(BotWorkspaces, workspaces)),
      Layer.provide(
        Layer.succeedContext(
          store.runtime.runSync(
            Effect.context<AgentRepository | DesktopControl>(),
          ),
        ),
      ),
    ),
  );

  try {
    runtime.runSync(Effect.void);
    expect(holds).toBe(1);

    control.set(agent.id, "owner");
    expect(holds).toBe(1);

    control.set(agent.id, "bot");
    expect(holds).toBe(0);

    control.set(agent.id, "owner");
    expect(holds).toBe(1);

    await runtime.dispose();
    expect(holds).toBe(0);

    control.set(agent.id, "bot");
    control.set(agent.id, "owner");
    expect(holds).toBe(0);
  } finally {
    await runtime.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
