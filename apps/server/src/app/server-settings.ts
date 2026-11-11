import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  DBAdapter,
} from "better-auth";
import { Schema } from "effect";
import type { z } from "@hono/zod-openapi";
import type { serverSettingsInput } from "../contract/admin";
import { serverSettingsSchema } from "../contract/admin";

export type ServerSettings = z.infer<typeof serverSettingsSchema>;

export type ServerSettingsPatch = z.infer<typeof serverSettingsInput>;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  signUpOpen: true,
  workspaceCpus: 2,
  workspaceMemoryMib: 4096,
  codingImage: null,
  questionGraceMinutes: 15,
};

const UNREADABLE_SETTINGS: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  signUpOpen: false,
};

const MODEL = "serverSetting";

export const serverTables = () =>
  ({
    id: "crumble-server",
    schema: {
      [MODEL]: {
        fields: {
          key: { type: "string", required: true, unique: true },
          value: { type: "string", required: true },
        },
      },
      invite: {
        fields: {
          tokenHash: { type: "string", required: true, unique: true },
          createdBy: { type: "string", required: true },
          createdAt: { type: "date", required: true },
          usedAt: { type: "date", required: false },
          usedBy: { type: "string", required: false },
          revokedAt: { type: "date", required: false },
        },
      },
    },
  }) satisfies BetterAuthPlugin;

const storedSettings = Schema.Array(
  Schema.Struct({ key: Schema.String, value: Schema.String }),
);

/** One decode per key: a value stored by an older or newer server can't reset the settings beside it. */
function decodeSettings(rows: typeof storedSettings.Type): ServerSettings {
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const setting = <K extends keyof ServerSettings>(key: K) => {
    const raw = stored.get(key);

    if (raw === undefined) return DEFAULT_SERVER_SETTINGS[key];

    try {
      // SAFETY: the schema of the setting named `key` parses it.
      return serverSettingsSchema.shape[key].parse(
        JSON.parse(raw),
      ) as ServerSettings[K];
    } catch {
      return UNREADABLE_SETTINGS[key];
    }
  };

  return {
    signUpOpen: setting("signUpOpen"),
    workspaceCpus: setting("workspaceCpus"),
    workspaceMemoryMib: setting("workspaceMemoryMib"),
    codingImage: setting("codingImage"),
    questionGraceMinutes: setting("questionGraceMinutes"),
  };
}

export type ServerSettingsStore = {
  get(): ServerSettings;
  update(patch: ServerSettingsPatch): Promise<ServerSettings>;
};

export async function serverSettingsStore<O extends BetterAuthOptions>(
  adapter: DBAdapter<O>,
): Promise<ServerSettingsStore> {
  const rows = Schema.decodeUnknownSync(storedSettings)(
    await adapter.findMany({ model: MODEL }),
  );

  let current = decodeSettings(rows);

  return {
    get: () => current,
    async update(patch) {
      const next = serverSettingsSchema.parse({ ...current, ...patch });

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const where = [{ field: "key", value: key }];
        const encoded = JSON.stringify(value);

        if (await adapter.findOne({ model: MODEL, where }))
          await adapter.update({
            model: MODEL,
            where,
            update: { value: encoded },
          });
        else
          await adapter.create({
            model: MODEL,
            data: { key, value: encoded },
          });
      }

      current = next;

      return current;
    },
  };
}
