import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  APIError,
  betterAuth,
  getCurrentAdapter,
  type BetterAuthOptions,
  type DBAdapter,
  type DBTransactionAdapter,
} from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { Option, Schema } from "effect";
import { getMigrations } from "better-auth/db/migration";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { authUsers } from "./auth-schema";
import { INVITE_HEADER, invites, type Invites } from "./invites";
import {
  serverSettingsStore,
  serverTables,
  type ServerSettingsStore,
} from "./server-settings";

export const ADMIN_ROLE = "admin";

/** What a passkey-only sign-up sends as its registration context. */
const PasskeySignUp = Schema.fromJsonString(
  Schema.Struct({
    email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+$/)),
    name: Schema.String.check(Schema.isMinLength(1)),
    invite: Schema.optionalKey(Schema.String),
  }),
);

const signUpClosed = () =>
  new APIError("FORBIDDEN", {
    message: "Sign-up is closed. Ask an admin for an invite link.",
  });

/** Promotes the oldest user on a server that has users but no admin, as one upgraded from before roles. */
async function ensureAdmin<O extends BetterAuthOptions>(adapter: DBAdapter<O>) {
  if (
    await adapter.count({
      model: "user",
      where: [{ field: "role", value: ADMIN_ROLE }],
    })
  )
    return;

  const [oldest] = await adapter.findMany<{ id: string }>({
    model: "user",
    sortBy: { field: "createdAt", direction: "asc" },
    limit: 1,
  });

  if (oldest)
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: oldest.id }],
      update: { role: ADMIN_ROLE },
    });
}

/**
 * The origin passkeys are bound to. WebAuthn rejects IP addresses as relying
 * party IDs, so a loopback origin maps to `localhost` on the same port.
 */
export function passkeyOriginFor(baseURL: string) {
  const url = new URL(baseURL);

  if (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    url.hostname = "localhost";

  return url.origin;
}

/** The browser origins allowed to call the server: its own, and the one passkeys are bound to. */
export function trustedOriginsFor(baseURL: string) {
  return [...new Set([new URL(baseURL).origin, passkeyOriginFor(baseURL)])];
}

export async function createAuth(dataDir: string, baseURL: string) {
  const secretPath = join(dataDir, ".auth-secret");

  if (!existsSync(secretPath))
    writeFileSync(secretPath, randomBytes(48).toString("hex"), {
      mode: 0o600,
      flag: "wx",
    });
  chmodSync(secretPath, 0o600);
  const database = new Database(join(dataDir, "auth.sqlite"));
  database.run("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const passkeyOrigin = passkeyOriginFor(baseURL);
  // Set once Better Auth is up; hooks only run on requests, after that.
  let settings: ServerSettingsStore;
  let inviteStore: Invites;

  const isFirstUser = async <O extends BetterAuthOptions>(
    adapter: DBTransactionAdapter<O>,
  ) => (await adapter.count({ model: "user" })) === 0;

  /** Whether someone without an account may create one now: first user, open sign-up, or an open invite. */
  const mayJoin = async <O extends BetterAuthOptions>(
    adapter: DBTransactionAdapter<O>,
    invite: string | undefined,
  ) =>
    (await isFirstUser(adapter)) ||
    settings.get().signUpOpen ||
    (invite !== undefined && (await inviteStore.isOpen(invite)));

  const options = {
    appName: "Crumble",
    baseURL,
    secret: readFileSync(secretPath, "utf8").trim(),
    database,
    trustedOrigins: trustedOriginsFor(baseURL),
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database" },
    databaseHooks: {
      user: {
        create: {
          // Every way to create a user passes here: the gate for closed sign-up and the first admin.
          async before(user, context) {
            if (!context) throw signUpClosed();
            const adapter = await getCurrentAdapter(context.context.adapter);

            if (await isFirstUser(adapter))
              return { data: { ...user, role: ADMIN_ROLE } };

            switch (context.path) {
              case "/admin/create-user":
              // afterVerification below admitted the passkey sign-up and used its invite.
              case "/passkey/verify-registration":
                return;
              case "/sign-up/email": {
                if (settings.get().signUpOpen) return;
                const invite = context.headers?.get(INVITE_HEADER);

                if (invite && (await inviteStore.consume(invite))) return;
                throw signUpClosed();
              }

              default:
                throw signUpClosed();
            }
          },
          async after(user, context) {
            const invite = context?.headers?.get(INVITE_HEADER);

            if (invite) await inviteStore.attribute(invite, user.id);
          },
        },
      },
    },
    plugins: [
      bearer(),
      admin(),
      serverTables(),
      passkey({
        rpID: new URL(passkeyOrigin).hostname,
        rpName: "Crumble",
        origin: passkeyOrigin,
        registration: {
          // A signed-in owner adds passkeys as before; without a session, a passkey alone signs up.
          requireSession: false,
          async resolveUser({ ctx, context }) {
            const signUp = Schema.decodeUnknownOption(PasskeySignUp)(context);

            if (Option.isNone(signUp))
              throw new APIError("BAD_REQUEST", {
                message: "A passkey sign-up needs an email and a name",
              });
            const { email, name, invite } = signUp.value;

            if (await ctx.context.internalAdapter.findUserByEmail(email))
              throw new APIError("BAD_REQUEST", {
                message: "An account with this email already exists",
              });

            if (!(await mayJoin(ctx.context.adapter, invite)))
              throw signUpClosed();

            return { id: randomUUID(), name: email, displayName: name };
          },
          async afterVerification({ ctx, user, context }) {
            if (await getSessionFromCtx(ctx)) return;

            const { email, name, invite } =
              Schema.decodeUnknownSync(PasskeySignUp)(context);

            const adapter = await getCurrentAdapter(ctx.context.adapter);

            if (
              !(await isFirstUser(adapter)) &&
              !settings.get().signUpOpen &&
              !(invite !== undefined && (await inviteStore.consume(invite)))
            )
              throw signUpClosed();

            const created = await ctx.context.internalAdapter.createUser(
              {
                id: user.id,
                email,
                name,
                emailVerified: false,
              },
              { method: "passkey" },
            );

            if (invite) await inviteStore.attribute(invite, created.id);

            return { userId: created.id };
          },
        },
      }),
    ],
  } satisfies BetterAuthOptions;

  try {
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    const auth = betterAuth(options);
    const users = drizzle({ client: database });
    const { adapter } = await auth.$context;

    settings = await serverSettingsStore(adapter);
    inviteStore = invites(adapter);
    await ensureAdmin(adapter);

    return {
      auth,
      settings,
      invites: inviteStore,
      adapter,
      isAdmin: async (userId: string) =>
        (await adapter.count({
          model: "user",
          where: [
            { field: "id", value: userId },
            { field: "role", value: ADMIN_ROLE },
          ],
        })) > 0,
      hasUser: (id: string) =>
        users
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.id, id))
          .get() !== undefined,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
