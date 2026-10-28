export function configureDevWorkspaces(
  env: Record<string, string | undefined>,
) {
  if (env["CRUMBLE_WORKSPACE_BACKEND"] === "railway") return;

  env["CRUMBLE_WORKSPACE_IMAGE"] ??=
    "ghcr.io/crumble-project/crumble-workspace:main";
  env["CRUMBLE_WORKSPACE_DESKTOP_IMAGE"] ??=
    "ghcr.io/crumble-project/crumble-workspace-desktop:main";
}
