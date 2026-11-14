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

export const inertControl: DesktopControlAccess = {
  get: () => BOT_HOLDS,
  set: () => BOT_HOLDS,
  subscribe: () => () => {},
  subscribeAll: () => () => {},
  untilBot: async () => BOT_HOLDS,
};

export const inertLogins: DesktopLogins = {
  access: {
    list: () => [],
    requests: () => [],
    request: nothingToSave,
    decline: async () => {},
    get: () => {},
    save: nothingToSave,
    delete: async () => {},
    uses: () => [],
    read: async () => ({ missing: "No logins" }),
    recordUse: () => {},
  },
  fills: () => ({ list: async () => [], add: async () => {} }),
};

export const inertIntent: DesktopIntent = {
  judgeFor: async () => ({
    name: "Inert judge",
    judge: async () => ({ irreversible: 0, inIntent: 1, inIntentBar: 0.9 }),
  }),
  held: {
    list: () => [],
    decide: nothingHeld,
    hold: nothingHeld,
    cardPosted: nothingHeld,
    expire: nothingHeld,
    until: nothingHeld,
  },
};

export const inertCredentials: CredentialsAccess = {
  list: () => ({ credentials: [], requests: [] }),
  request: nothingToSave,
  decline: async () => {},
  save: nothingToSave,
  delete: async () => {},
  uses: () => [],
  env: () => ({}),
  workspaceSection: () => {},
  grants: () => [],
  value: () => Promise.reject(new Error("No credentials")),
  recordUse: () => {},
};
