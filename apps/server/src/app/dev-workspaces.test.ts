import { expect, test } from "bun:test";
import { configureDevWorkspaces } from "./dev-workspaces";
import { microsandboxWorkspacesFromEnv } from "../workspaces/microsandbox-workspaces";

test("development enables coding and desktop workspaces by default", () => {
  const env: Record<string, string | undefined> = {};
  configureDevWorkspaces(env);

  const workspaces = microsandboxWorkspacesFromEnv(env, {
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

  configureDevWorkspaces(env);

  expect(env).toEqual({
    CRUMBLE_WORKSPACE_IMAGE: "custom",
    CRUMBLE_WORKSPACE_DESKTOP_IMAGE: "",
  });

  const railway = { CRUMBLE_WORKSPACE_BACKEND: "railway" };
  configureDevWorkspaces(railway);
  expect(railway).toEqual({ CRUMBLE_WORKSPACE_BACKEND: "railway" });
});
