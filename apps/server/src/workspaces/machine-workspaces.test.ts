import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  MachineWorkspaces,
  type WorkspaceMachine,
  type WorkspaceMachines,
} from "./machine-workspaces";
import { DesktopStartFailed, WorkspaceStreamFailed } from "./workspace-errors";

const BASE = "base";
const DESKTOP = "desktop";

/** A backend whose machines do nothing; `fail` picks the step that fails. */
function fakeMachines(fail?: "desktop" | "stream") {
  const booted: string[] = [];
  const stopped: string[] = [];

  const machine = (image: string): WorkspaceMachine => ({
    image,
    isAlive: Effect.succeed(true),
    desktopReady: Effect.void,
    stream: (command) =>
      fail === "stream"
        ? Effect.fail(
            new WorkspaceStreamFailed({
              message: `${command} did not start`,
              cause: "no socat",
            }),
          )
        : Effect.succeed({
            write: async () => undefined,
            end: async () => undefined,
            output: (async function* () {})(),
          }),
    sync: Effect.void,
    stop: Effect.sync(() => void stopped.push(image)),
  });

  const machines: WorkspaceMachines = {
    kind: "fake",
    boot: (_agentId, image) =>
      Effect.gen(function* () {
        booted.push(image);

        if (fail === "desktop" && image === DESKTOP)
          return yield* new DesktopStartFailed({
            message: "The bot desktop did not start: Xvnc died",
            cause: "Xvnc died",
          });

        return machine(image);
      }),
  };

  return { machines, booted, stopped };
}

const failureOf = <A, E extends { _tag: string }>(
  effect: Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.flip,
      Effect.map((error) => error._tag),
    ),
  );

test("a server without a desktop image names that, without booting", async () => {
  const { machines, booted } = fakeMachines();
  const workspaces = new MachineWorkspaces(machines, BASE);

  expect(await failureOf(workspaces.openDesktop("bot"))).toBe(
    "DesktopNotConfigured",
  );
  expect(booted).toEqual([]);
});

test("a bot without the desktop tool gets no bot desktop, without booting", async () => {
  const { machines, booted } = fakeMachines();

  const workspaces = new MachineWorkspaces(machines, BASE, {
    desktopImage: DESKTOP,
  });

  expect(await failureOf(workspaces.openDesktop("bot"))).toBe(
    "DesktopNotEnabled",
  );
  expect(booted).toEqual([]);
});

test("a desktop that does not start fails the open, and the next open boots again", async () => {
  const { machines, booted } = fakeMachines("desktop");

  const workspaces = new MachineWorkspaces(machines, BASE, {
    desktopImage: DESKTOP,
    wantsDesktop: () => true,
  });

  expect(await failureOf(workspaces.openDesktop("bot"))).toBe(
    "DesktopStartFailed",
  );
  expect(await failureOf(workspaces.startDesktop("bot"))).toBe(
    "DesktopStartFailed",
  );
  expect(booted).toEqual([DESKTOP, DESKTOP]);
});

test("a VNC stream that does not open releases the machine for its idle stop", async () => {
  const { machines, stopped } = fakeMachines("stream");

  const workspaces = new MachineWorkspaces(machines, BASE, {
    desktopImage: DESKTOP,
    wantsDesktop: () => true,
    idleTimeoutMs: 10,
  });

  expect(await failureOf(workspaces.openDesktop("bot"))).toBe(
    "WorkspaceStreamFailed",
  );
  await Bun.sleep(100);
  expect(stopped).toEqual([DESKTOP]);
  await Effect.runPromise(workspaces.close());
});

test("closed workspaces boot nothing more", async () => {
  const { machines, booted } = fakeMachines();

  const workspaces = new MachineWorkspaces(machines, BASE, {
    desktopImage: DESKTOP,
    wantsDesktop: () => true,
  });

  await Effect.runPromise(workspaces.close());
  expect(await failureOf(workspaces.startDesktop("bot"))).toBe(
    "WorkspacesClosed",
  );
  expect(booted).toEqual([]);
});
