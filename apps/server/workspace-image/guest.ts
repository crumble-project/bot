import path from "node:path";

// What a workspace guest holds, for the server and for Railway's recipes. The Dockerfile and desktop-start.sh can't
// import it, so src/workspaces/guest-image.test.ts fails when they drift.

/** The guest path where a bot's workspace lives; the bot's shell and its coding jobs start here. */
export const WORKSPACE_PATH = "/workspace";

/** Where images and uploads keep Crumble's guest files. */
export const GUEST_FILES = "/opt/crumble";

/** Where a backend uploads the helper programs it runs in the guest. */
export const GUEST_HELPERS = "/usr/local/lib/crumble";

/** `init.templateDir` of every job: its hook marks commits a bot makes as its owner. */
export const GIT_TEMPLATE_DIR = `${GUEST_FILES}/git-template`;

/** Started at boot on a desktop image, not through pi-env: its daemon kills what it started when the connection closes. */
export const DESKTOP_START = `${GUEST_FILES}/desktop-start.sh`;

/** Makes `DESKTOP_START` return once the VNC server listens, before the browser is up. */
export const DESKTOP_DISPLAY_ONLY = "--display";

/** Written by `DESKTOP_START`: the display and session bus every command on the bot desktop needs. */
export const DESKTOP_ENV_FILE = "/run/crumble-desktop.env";

export const VNC_PORT = 5900;

/** The panel and the wallpaper, which list as windows. */
export const DESKTOP_CHROME_APPS = ["xfce4-panel", "xfdesktop"];

export const FILES_PROGRAM = "thunar";

export const TERMINAL_PROGRAM = "xfce4-terminal";

/** Host folders of what goes into a guest. */
export const DESKTOP_SOURCES = path.join(import.meta.dir, "desktop");

export const GIT_TEMPLATE_SOURCES = path.join(import.meta.dir, "git-template");

export const BASE_PACKAGES = [
  "bash",
  "build-essential",
  "ca-certificates",
  "curl",
  "file",
  "git",
  "jq",
  "make",
  "openssh-client",
  "procps",
  "python3",
  "python3-venv",
  "ripgrep",
  "unzip",
  "xz-utils",
];

/** On top of the base packages; each image brings its own Chromium. */
export const DESKTOP_PACKAGES = [
  "tigervnc-standalone-server",
  "xfwm4",
  "xfce4-panel",
  "xfdesktop4",
  "thunar",
  "mousepad",
  "ristretto",
  "xfce4-terminal",
  "librsvg2-common",
  "wmctrl",
  "xclip",
  "xdotool",
  "imagemagick",
  "fonts-dejavu-core",
  "fonts-noto-color-emoji",
  "socat",
  "dbus-x11",
  "at-spi2-core",
  "x11-utils",
  "zenity",
  "libnss3-tools",
];

export const UV_VERSION = "0.13.1";

export const BUN_VERSION = "1.4.4";

export const GH = {
  version: "2.103.3",
  sha256: {
    amd64: "4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d",
    arm64: "ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63",
  },
};

export const CUA_DRIVER = {
  version: "0.38.0",
  sha256: {
    x86_64: "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd",
    arm64: "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d",
  },
};

export const BASE_ENV = {
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_PROMPT_DISABLED: "1",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
};

/** cua-driver's telemetry is on by default. */
export const DESKTOP_ENV = {
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  DO_NOT_TRACK: "1",
};

/** The variables as `NAME=value` words, as a shell command or Dockerfile `ENV` takes them. */
export const envWords = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
