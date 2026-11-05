import type { DesktopControlAccess } from "../../src/bot-desktop/desktop-control";
import type { DesktopIntent } from "../../src/bot-desktop/desktop-intent";
import type { DesktopLogins } from "../../src/bot-desktop/desktop-jobs";
import type { CredentialsAccess } from "../../src/credentials/credentials";

const nothingToSave = () => {
  throw new Error("Nothing to save in this fixture");
};

const nothingHeld = () => Promise.reject(new Error("Nothing is held"));

const BOT_HOLDS = {
  holder: "bot",
  changes: 0,
  updatedAt: new Date(0).toISOString(),
} as const;

/** A bot desktop the bot always holds. */
export const inertControl: DesktopControlAccess = {
  get: () => BOT_HOLDS,
  set: () => BOT_HOLDS,
  subscribe: () => () => undefined,
  subscribeAll: () => () => undefined,
  untilBot: async () => BOT_HOLDS,
};

/** An account with no logins. */
export const inertLogins: DesktopLogins = {
  access: {
    list: () => [],
    requests: () => [],
    request: nothingToSave,
    decline: async () => undefined,
    get: () => undefined,
    save: nothingToSave,
    delete: async () => undefined,
    uses: () => [],
    read: async () => ({ missing: "No logins" }),
    recordUse: () => undefined,
  },
  fills: () => ({ list: async () => [], add: async () => undefined }),
};

/** A judge that finds every action asked for and reversible. */
export const inertIntent: DesktopIntent = {
  judgeFor: async () => ({
    name: "Inert judge",
    judge: async () => ({ irreversible: 0, inIntent: 1, inIntentBar: 0.9 }),
  }),
  held: {
    list: () => [],
    decide: nothingHeld,
    hold: nothingHeld,
    until: nothingHeld,
  },
};

/** An account with no credentials. */
export const inertCredentials: CredentialsAccess = {
  list: () => ({ credentials: [], requests: [] }),
  request: nothingToSave,
  decline: async () => undefined,
  save: nothingToSave,
  delete: async () => undefined,
  uses: () => [],
  env: () => ({}),
  workspaceSection: () => undefined,
  grants: () => [],
  value: () => Promise.reject(new Error("No credentials")),
  recordUse: () => undefined,
};
