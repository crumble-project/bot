import { z } from "@hono/zod-openapi";
import { body, define, empty, json } from "./route";

export const roleSchema = z.enum(["admin", "user"]);

export const serverSettingsSchema = z
  .object({
    signUpOpen: z.boolean(),
    workspaceCpus: z.number().int().min(1).max(64),
    workspaceMemoryMib: z.number().int().min(512).max(262_144),
    codingImage: z
      .string()
      .trim()
      .regex(/^[a-z0-9][\w.\-/:@]{0,254}$/)
      .nullable()
      .describe(
        "Image new workspaces boot from, such as `ghcr.io/owner/image:tag`; null uses the server's `CRUMBLE_WORKSPACE_IMAGE`.",
      ),
    questionGraceMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .describe(
        "How long a coding job waiting on the owner's answer keeps its workspace running.",
      ),
  })
  .openapi("ServerSettings");

export const serverSettingsInput = serverSettingsSchema.partial();

export const adminUser = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: roleSchema,
    createdAt: z.string(),
  })
  .openapi("AdminUser");

export const invite = z
  .object({ id: z.string(), createdAt: z.string() })
  .openapi("Invite");

const userId = z.object({ id: z.string().min(1).max(128) });

export const adminRoutes = {
  adminUsers: define({
    method: "get",
    path: "/v1/admin/users",
    operationId: "listUsers",
    description: "Every account on the server, oldest first. Admins only.",
    responses: { 200: json(z.object({ users: z.array(adminUser) })) },
  }),
  setUserRole: define({
    method: "patch",
    path: "/v1/admin/users/{id}",
    operationId: "setUserRole",
    description:
      "Makes the account an admin or a regular user. 409 when it would leave the server without an admin. Admins only.",
    request: { params: userId, body: body(z.object({ role: roleSchema })) },
    responses: { 200: json(adminUser) },
  }),
  removeUser: define({
    method: "delete",
    path: "/v1/admin/users/{id}",
    operationId: "removeUser",
    description:
      "Removes the account, its sessions, and all its data, bots included. 409 for the caller's own account. Admins only.",
    request: { params: userId },
    responses: { 204: empty },
  }),
  invites: define({
    method: "get",
    path: "/v1/admin/invites",
    operationId: "listInvites",
    description:
      "Invite links not yet used or revoked, newest first. Admins only.",
    responses: { 200: json(z.object({ invites: z.array(invite) })) },
  }),
  createInvite: define({
    method: "post",
    path: "/v1/admin/invites",
    operationId: "createInvite",
    description:
      "Makes a one-time invite link. Only its hash is stored, so the link is shown once. Admins only.",
    responses: {
      200: json(invite.extend({ url: z.string() }).openapi("CreatedInvite")),
    },
  }),
  revokeInvite: define({
    method: "delete",
    path: "/v1/admin/invites/{id}",
    operationId: "revokeInvite",
    description: "Revokes an invite link. Admins only.",
    request: { params: userId },
    responses: { 204: empty },
  }),
  outdatedWorkspaces: define({
    method: "get",
    path: "/v1/admin/workspaces/outdated",
    operationId: "listOutdatedWorkspaces",
    description:
      "Running workspaces whose machine has another image than the server's settings name. Each switches at its next idle stop, keeping its files; stopped workspaces switch when they next start. Admins only.",
    responses: {
      200: json(
        z.object({
          workspaces: z.array(
            z.object({ userId: z.string(), agentId: z.string() }),
          ),
        }),
      ),
    },
  }),
  serverSettings: define({
    method: "get",
    path: "/v1/admin/settings",
    operationId: "getServerSettings",
    description: "The server's settings. Admins only.",
    responses: { 200: json(serverSettingsSchema) },
  }),
  updateServerSettings: define({
    method: "patch",
    path: "/v1/admin/settings",
    operationId: "updateServerSettings",
    description:
      "Changes the given settings. New workspace size and image apply to workspaces as they boot. Admins only.",
    request: { body: body(serverSettingsInput) },
    responses: { 200: json(serverSettingsSchema) },
  }),
};
