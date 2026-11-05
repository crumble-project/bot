/** The workspace environment of a development server: the published images, unless `env` chooses otherwise. */
export function devWorkspaceEnv(env: Record<string, string | undefined>) {
  if (env["CRUMBLE_WORKSPACE_BACKEND"] === "railway") return env;

  return {
    ...env,
    CRUMBLE_WORKSPACE_IMAGE:
      env["CRUMBLE_WORKSPACE_IMAGE"] ??
      "ghcr.io/crumble-project/crumble-workspace:main",
    CRUMBLE_WORKSPACE_DESKTOP_IMAGE:
      env["CRUMBLE_WORKSPACE_DESKTOP_IMAGE"] ??
      "ghcr.io/crumble-project/crumble-workspace-desktop:main",
  };
}
