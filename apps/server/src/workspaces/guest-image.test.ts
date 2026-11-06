import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BASE_ENV,
  BASE_PACKAGES,
  BUN_VERSION,
  CUA_DRIVER,
  DESKTOP_CHROME_APPS,
  DESKTOP_ENV,
  DESKTOP_ENV_FILE,
  DESKTOP_PACKAGES,
  DESKTOP_SOURCES,
  FILES_PROGRAM,
  GH,
  GIT_TEMPLATE_DIR,
  GUEST_FILES,
  TERMINAL_PROGRAM,
  UV_VERSION,
  VNC_PORT,
  WORKSPACE_PATH,
  envWords,
} from "../../workspace-image/guest";
import { BASE_RECIPE, DESKTOP_RECIPE } from "./railway/railway-workspaces";

const dockerfile = readFileSync(
  path.join(import.meta.dir, "../../workspace-image/Dockerfile"),
  "utf8",
);

const startScript = readFileSync(
  path.join(DESKTOP_SOURCES, "desktop-start.sh"),
  "utf8",
);

const [, baseStage = "", desktopStage = ""] = dockerfile.split(/^FROM .*$/m);

const aptPackages = (stage: string) =>
  /apt-get install -y --no-install-recommends \\\n([\s\S]*?)\\\n\s*&& rm/
    .exec(stage)?.[1]
    ?.replace(/\\\n/g, " ")
    .trim()
    .split(/\s+/)
    .toSorted();

// Railway gets its Chromium as a pinned snapshot build: Ubuntu ships it only as a snap, which a sandbox can't run.
const DOCKERFILE_ONLY_PACKAGES = ["chromium"];

describe("the Dockerfile matches the guest manifest", () => {
  test("packages", () => {
    expect(aptPackages(baseStage)).toEqual(BASE_PACKAGES.toSorted());
    expect(aptPackages(desktopStage)).toEqual(
      [...DESKTOP_PACKAGES, ...DOCKERFILE_ONLY_PACKAGES].toSorted(),
    );
  });

  test("versions and checksums", () => {
    for (const line of [
      `COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} `,
      `COPY --from=oven/bun:${BUN_VERSION}-debian `,
      `ARG GH_VERSION=${GH.version}\n`,
      `ARG GH_SHA256_AMD64=${GH.sha256.amd64}\n`,
      `ARG GH_SHA256_ARM64=${GH.sha256.arm64}\n`,
      `ARG CUA_DRIVER_VERSION=${CUA_DRIVER.version}\n`,
      `ARG CUA_DRIVER_SHA256_ARM64=${CUA_DRIVER.sha256.arm64}\n`,
      `ARG CUA_DRIVER_SHA256_X86_64=${CUA_DRIVER.sha256.x86_64}\n`,
    ])
      expect(dockerfile).toContain(line);
  });

  test("environment", () => {
    const set = dockerfile
      .match(/^ENV .*$/gm)
      ?.flatMap((line) => line.slice("ENV ".length).split(" "));

    expect(set?.toSorted()).toEqual(
      envWords({ ...BASE_ENV, ...DESKTOP_ENV })
        .split(" ")
        .toSorted(),
    );
  });

  test("paths", () => {
    expect(dockerfile).toContain(`COPY git-template ${GIT_TEMPLATE_DIR}\n`);
    expect(dockerfile).toContain(`COPY desktop/ ${GUEST_FILES}/\n`);
    expect(dockerfile).toContain(`WORKDIR ${WORKSPACE_PATH}\n`);
  });
});

describe("the desktop start script matches the guest manifest", () => {
  test("paths and ports", () => {
    for (const text of [
      `here=${GUEST_FILES}\n`,
      `-rfbport ${VNC_PORT} `,
      `/dev/tcp/127.0.0.1/${VNC_PORT}`,
      `> ${DESKTOP_ENV_FILE}\n`,
      `. ${DESKTOP_ENV_FILE}\n`,
      `file://${WORKSPACE_PATH} `,
      `cd ${WORKSPACE_PATH} `,
    ])
      expect(startScript).toContain(text);
  });

  test("environment", () => {
    expect(startScript).toContain(
      `echo "export DISPLAY=:1 ${envWords(DESKTOP_ENV)}"`,
    );
  });

  test("the programs the computer_use tool names", () => {
    for (const app of DESKTOP_CHROME_APPS)
      expect(startScript).toContain(`nohup ${app} `);

    expect(DESKTOP_PACKAGES).toContain(FILES_PROGRAM);
    expect(DESKTOP_PACKAGES).toContain(TERMINAL_PROGRAM);
  });
});

describe("Railway's recipes match the guest manifest", () => {
  test("they install the manifest's packages", () => {
    expect(BASE_RECIPE.packages).toEqual(BASE_PACKAGES);
    expect(DESKTOP_RECIPE.packages).toEqual([
      ...BASE_PACKAGES,
      ...DESKTOP_PACKAGES,
    ]);
  });

  test("they install gh and the git template, which every job's git config names", () => {
    const steps = BASE_RECIPE.steps.join("\n");

    expect(steps).toContain(`/usr/local/bin/gh`);
    expect(steps).toContain(GH.sha256.amd64);
    expect(steps).toContain(`${GIT_TEMPLATE_DIR}/hooks/prepare-commit-msg`);
  });
});
