import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MachineWorkspaces,
  type WorkspaceMachine,
  type WorkspaceMachines,
} from "./machine-workspaces";
import {
  BotWorkspaces,
  WorkspaceBootError,
  WorkspaceClosed,
  WorkspaceDesktopDisabled,
  WorkspaceDesktopUnavailable,
  WorkspaceSetupError,
  WorkspaceDesktopStartError,
  WorkspaceStopError,
  WorkspaceStreamError,
  workspacePromise,
  type Workspaces,
} from "./workspace";

const failure = (cause: unknown, operation: string) => ({
  agentId: "bot",
  backend: "fake",
  operation,
  cause,
});

function fixture(overrides: Partial<WorkspaceMachine> = {}) {
  const events: string[] = [];

  const machines: WorkspaceMachines = {
    kind: "fake",
    boot: (_agentId, image) =>
      Effect.sync(() => {
        events.push(`boot:${image}`);

        return {
          image,
          isAlive: () => Effect.succeed(true),
          desktopReady: () => Effect.void,
          stream: () =>
            Effect.succeed({
              write: async () => undefined,
              end: async () => undefined,
              output: (async function* () {
                yield new Uint8Array([1]);
              })(),
            }),
          sync: () =>
            Effect.sync(() => {
              events.push("sync");
            }),
          stop: () =>
            Effect.sync(() => {
              events.push("stop");
            }),
          ...overrides,
        };
      }),
  };

  return { machines, events };
}

const desktopOptions = { desktopImage: "desktop", wantsDesktop: () => true };

test("all workspace operations reject closed service use", async () => {
  const { machines } = fixture();
  const workspaces = new MachineWorkspaces(machines, "base", desktopOptions);
  await workspacePromise(workspaces.close());

  for (const operation of [
    workspaces.env("bot"),
    workspaces.restart("bot"),
    workspaces.sync("bot"),
    workspaces.openDesktop("bot"),
    workspaces.startDesktop("bot"),
    workspaces.keepAwake("bot"),
  ]) {
    const exit = await Effect.runPromise(operation.pipe(Effect.exit));
    expect(exit._tag).toBe("Failure");
  }

  expect(
    await Effect.runPromise(workspaces.env("bot").pipe(Effect.flip)),
  ).toBeInstanceOf(WorkspaceClosed);
});

test("missing desktop configuration and plain-image bots are distinct and never boot", async () => {
  const { machines, events } = fixture();

  const missing = new MachineWorkspaces(machines, "base", {
    wantsDesktop: () => true,
  });

  const plain = new MachineWorkspaces(machines, "base", {
    desktopImage: "desktop",
  });

  expect(
    await Effect.runPromise(missing.openDesktop("bot").pipe(Effect.flip)),
  ).toBeInstanceOf(WorkspaceDesktopUnavailable);
  expect(
    await Effect.runPromise(plain.startDesktop("bot").pipe(Effect.flip)),
  ).toBeInstanceOf(WorkspaceDesktopDisabled);
  expect(events).toEqual([]);
});

test("concurrent viewers share one boot and do not wait for browser readiness", async () => {
  let interrupted = false;

  const { machines, events } = fixture({
    desktopReady: () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
  });

  const workspaces = new MachineWorkspaces(machines, "base", desktopOptions);

  try {
    await Promise.all([
      workspacePromise(workspaces.startDesktop("bot")),
      workspacePromise(workspaces.startDesktop("bot")),
    ]);
    const stream = await workspacePromise(workspaces.openDesktop("bot"));
    expect(events).toEqual(["boot:desktop"]);
    await stream.close();
  } finally {
    await workspacePromise(workspaces.close());
  }

  expect(interrupted).toBe(true);
  expect(events).toEqual(["boot:desktop", "stop"]);
});

test("restarts serialize teardown before the next boot", async () => {
  let desktop = true;
  const { machines, events } = fixture();

  const workspaces = new MachineWorkspaces(machines, "base", {
    desktopImage: "desktop",
    wantsDesktop: () => desktop,
  });

  try {
    await workspacePromise(workspaces.startDesktop("bot"));
    desktop = false;
    await workspacePromise(workspaces.restart("bot"));
    desktop = true;
    await workspacePromise(workspaces.startDesktop("bot"));
    expect(events).toEqual(["boot:desktop", "stop", "boot:desktop"]);
  } finally {
    await workspacePromise(workspaces.close());
  }
});

test("idle holds are idempotent and viewers release their own hold", async () => {
  const { machines, events } = fixture();

  const workspaces = new MachineWorkspaces(machines, "base", {
    ...desktopOptions,
    idleTimeoutMs: 5,
  });

  try {
    const release = await workspacePromise(workspaces.keepAwake("bot"));
    const viewer = await workspacePromise(workspaces.openDesktop("bot"));
    await viewer.close();
    await Bun.sleep(25);
    expect(events).toEqual(["boot:desktop"]);
    release();
    release();
    await Bun.sleep(25);
    expect(events).toEqual(["boot:desktop", "stop"]);
  } finally {
    await workspacePromise(workspaces.close());
  }
});

test("a failed desktop stream releases its idle hold and preserves the backend cause", async () => {
  const cause = { sdkCode: "UNKNOWN_FAILURE" };
  const error = new WorkspaceStreamError(failure(cause, "socat"));
  const { machines, events } = fixture({ stream: () => Effect.fail(error) });

  const workspaces = new MachineWorkspaces(machines, "base", {
    ...desktopOptions,
    idleTimeoutMs: 5,
  });

  try {
    expect(
      await Effect.runPromise(workspaces.openDesktop("bot").pipe(Effect.flip)),
    ).toBe(error);
    expect(error.cause).toBe(cause);
    await Bun.sleep(25);
    expect(events).toEqual(["boot:desktop", "stop"]);
  } finally {
    await workspacePromise(workspaces.close());
  }
});

test("typed boot failures retain their identity instead of becoming generic failures", async () => {
  const error = new WorkspaceDesktopStartError(
    failure(new Error("display start failed"), "display"),
  );

  const workspaces = new MachineWorkspaces(
    { kind: "fake", boot: () => Effect.fail(error) },
    "base",
    desktopOptions,
  );

  expect(
    await Effect.runPromise(workspaces.openDesktop("bot").pipe(Effect.flip)),
  ).toBe(error);
  await workspacePromise(workspaces.close());
});

test("credential setup failures preserve the original cause and do not boot", async () => {
  const cause = { reason: "certificate read failed" };
  const { machines, events } = fixture();

  const workspaces = new MachineWorkspaces(machines, "base", {
    ...desktopOptions,
    caCertificate: async () => {
      throw cause;
    },
  });

  const error = await Effect.runPromise(
    workspaces.startDesktop("bot").pipe(Effect.flip),
  );

  expect(error).toBeInstanceOf(WorkspaceSetupError);
  expect(error).toMatchObject({ operation: "credential authority", cause });
  expect(events).toEqual([]);
  await workspacePromise(workspaces.close());
});

test("close attempts every machine even when one stop fails", async () => {
  let stopped = 0;

  const error = new WorkspaceStopError(
    failure(new Error("stop failed"), "stop"),
  );

  const { machines } = fixture({
    stop: () =>
      Effect.suspend(() => {
        stopped += 1;

        return stopped === 1 ? Effect.fail(error) : Effect.void;
      }),
  });

  const workspaces = new MachineWorkspaces(machines, "base", desktopOptions);
  await workspacePromise(workspaces.startDesktop("one"));
  await workspacePromise(workspaces.startDesktop("two"));
  expect(await Effect.runPromise(workspaces.close().pipe(Effect.flip))).toBe(
    error,
  );
  expect(stopped).toBe(2);
});

test("BotWorkspaces releases its resource without turning a cleanup failure into a defect", async () => {
  const error = new WorkspaceBootError(
    failure(new Error("cleanup failed"), "close"),
  );

  const { machines } = fixture();
  const workspaces = new MachineWorkspaces(machines, "base");
  let closed = 0;

  const resource: Workspaces = {
    desktop: workspaces.desktop,
    env: (agentId, shellEnv) => workspaces.env(agentId, shellEnv),
    restart: (agentId) => workspaces.restart(agentId),
    sync: (agentId) => workspaces.sync(agentId),
    keepAwake: (agentId) => workspaces.keepAwake(agentId),
    startDesktop: (agentId) => workspaces.startDesktop(agentId),
    openDesktop: (agentId) => workspaces.openDesktop(agentId),
    close: () =>
      Effect.suspend(() => {
        closed += 1;

        return Effect.fail(error);
      }),
  };

  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* BotWorkspaces).toBe(resource);
    }).pipe(Effect.provide(BotWorkspaces.layer(() => resource))),
  );
  expect(closed).toBe(1);
});
