import { expect, test } from "bun:test";
import { devWorkspaceEnv } from "./dev-workspaces";
import { microsandboxWorkspacesFromEnv } from "../workspaces/microsandbox-workspaces";

test("development enables coding and desktop workspaces by default", () => {
  const workspaces = microsandboxWorkspacesFromEnv(devWorkspaceEnv({}), {
    namePrefix: "crumble",
    size: () => ({ cpus: 2, memoryMib: 4096 }),
    wantsDesktop: () => true,
  });

  expect(workspaces?.imageFor("bot")).toBe(
    "ghcr.io/crumble-project/crumble-workspace-desktop:main",
  );
  expect(workspaces?.desktop).toBe(true);
});

test("development preserves workspace overrides and Railway configuration", () => {
  const env = {
    CRUMBLE_WORKSPACE_IMAGE: "custom",
    CRUMBLE_WORKSPACE_DESKTOP_IMAGE: "",
  };

  expect(devWorkspaceEnv(env)).toEqual(env);

  const railway = { CRUMBLE_WORKSPACE_BACKEND: "railway" };
  expect(devWorkspaceEnv(railway)).toEqual(railway);
});
