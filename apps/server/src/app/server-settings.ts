import type {
  BetterAuthOptions,
  BetterAuthPlugin,
  DBAdapter,
} from "better-auth";
import { Schema } from "effect";
import type { z } from "@hono/zod-openapi";
import { serverSettingsInput, serverSettingsSchema } from "../contract/admin";

export type ServerSettings = z.infer<typeof serverSettingsSchema>;

export type ServerSettingsPatch = z.infer<typeof serverSettingsInput>;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = {
  signUpOpen: true,
  workspaceCpus: 2,
  workspaceMemoryMib: 4096,
  codingImage: null,
  questionGraceMinutes: 15,
};

const MODEL = "serverSetting";

/** Adds the host's own tables to `auth.sqlite`, so Better Auth migrates them with its own. */
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

export type ServerSettingsStore = {
  get(): ServerSettings;
  update(patch: ServerSettingsPatch): Promise<ServerSettings>;
  subscribe(listener: (settings: ServerSettings) => void): () => void;
};

/** The server's settings, cached in memory: workspaces read them synchronously at every boot. */
export async function serverSettingsStore<O extends BetterAuthOptions>(
  adapter: DBAdapter<O>,
): Promise<ServerSettingsStore> {
  const rows = Schema.decodeUnknownSync(storedSettings)(
    await adapter.findMany({ model: MODEL }),
  );

  const stored = Object.fromEntries(
    rows.map((row) => [row.key, JSON.parse(row.value)]),
  );

  // A setting stored by an older or newer server that no longer decodes falls back to its default.
  // A stored value that no longer validates falls back to all defaults rather than failing the server's start.
  let current = serverSettingsSchema
    .catch(DEFAULT_SERVER_SETTINGS)
    .parse({ ...DEFAULT_SERVER_SETTINGS, ...stored });

  const listeners = new Set<(settings: ServerSettings) => void>();

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

      for (const listener of listeners) listener(current);

      return current;
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
  };
}
