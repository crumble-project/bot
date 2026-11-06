import { createHash, randomBytes } from "node:crypto";
import {
  getCurrentAdapter,
  type BetterAuthOptions,
  type DBAdapter,
} from "better-auth";
import { Schema } from "effect";

export const INVITE_HEADER = "x-crumble-invite";

const MODEL = "invite";

export const Invite = Schema.Struct({
  id: Schema.String,
  createdBy: Schema.String,
  createdAt: Schema.Date,
  usedAt: Schema.NullishOr(Schema.Date),
  usedBy: Schema.NullishOr(Schema.String),
  revokedAt: Schema.NullishOr(Schema.Date),
});

export type Invite = typeof Invite.Type;

const decodeInvites = Schema.decodeUnknownSync(Schema.Array(Invite));

const hashOf = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function invites<O extends BetterAuthOptions>(base: DBAdapter<O>) {
  // Inside a sign-up's transaction, queries must join it: SQLite would wait on the transaction forever.
  const db = () => getCurrentAdapter(base);

  const open = async (token: string) => {
    const [invite] = decodeInvites(
      await (
        await db()
      ).findMany({
        model: MODEL,
        where: [{ field: "tokenHash", value: hashOf(token) }],
        limit: 1,
      }),
    );

    return invite && !invite.usedAt && !invite.revokedAt ? invite : undefined;
  };

  return {
    async create(createdBy: string) {
      const token = randomBytes(32).toString("base64url");

      const created = await (
        await db()
      ).create<{ id: string }>({
        model: MODEL,
        data: { tokenHash: hashOf(token), createdBy, createdAt: new Date() },
      });

      return { id: created.id, token };
    },

    async pending() {
      return decodeInvites(
        await (
          await db()
        ).findMany({
          model: MODEL,
          sortBy: { field: "createdAt", direction: "desc" },
        }),
      ).filter((invite) => !invite.usedAt && !invite.revokedAt);
    },

    async revoke(id: string) {
      const revoked = await (
        await db()
      ).update({
        model: MODEL,
        where: [{ field: "id", value: id }],
        update: { revokedAt: new Date() },
      });

      return revoked !== null;
    },

    isOpen: async (token: string) => (await open(token)) !== undefined,

    async consume(token: string) {
      const invite = await open(token);

      if (!invite) return false;
      await (
        await db()
      ).update({
        model: MODEL,
        where: [{ field: "id", value: invite.id }],
        update: { usedAt: new Date() },
      });

      return true;
    },

    async attribute(token: string, userId: string) {
      await (
        await db()
      ).update({
        model: MODEL,
        where: [{ field: "tokenHash", value: hashOf(token) }],
        update: { usedBy: userId },
      });
    },
  };
}

export type Invites = ReturnType<typeof invites>;
