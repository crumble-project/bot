import { expect, test } from "bun:test";
import { localEnvironment } from "./emulate-process";

test("local child environments exclude installation, provider and preload configuration", () => {
  expect(
    localEnvironment({
      PATH: "/bin",
      HOME: "/tmp/local-home",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      CRUMBLE_DATA_DIR: "/ordinary-data",
      CRUMBLE_PUBLIC_URL: "https://example.test",
      CRUMBLE_FCM_SERVICE_ACCOUNT_PATH: "/private/key.json",
      BETTER_AUTH_URL: "https://example.test",
      OPENAI_API_KEY: "dummy-not-forwarded",
      ANTHROPIC_API_KEY: "dummy-not-forwarded",
      BUN_OPTIONS: "--preload=unwanted.ts",
      NODE_OPTIONS: "--require=unwanted.cjs",
      HTTPS_PROXY: "http://example.test",
    }),
  ).toEqual({
    PATH: "/bin",
    HOME: "/tmp/local-home",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
  });
});
