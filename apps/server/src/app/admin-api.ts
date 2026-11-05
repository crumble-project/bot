import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { createAuth } from "./auth";
import { ADMIN_ROLE, adminCount } from "./auth";
import { handleApiError } from "./api-errors";
import { limitBodies, pathRegister } from "./api-requests";
import { routes } from "../contract/api-contract";

type Accounts = Awaited<ReturnType<typeof createAuth>>;

type StoredUser = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  createdAt: Date;
};

const userOf = (user: StoredUser) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role === ADMIN_ROLE ? ("admin" as const) : ("user" as const),
  createdAt: user.createdAt.toISOString(),
});

export function adminAPI(options: {
  accounts: Accounts;
  origin: () => string;
  removeAccount: (userId: string) => Promise<void>;
  outdatedWorkspaces: () => Promise<{ userId: string; agentId: string }[]>;
}) {
  const { accounts } = options;
  const { adapter, auth, settings, invites } = accounts;
  const app = new OpenAPIHono<{ Variables: { adminId: string } }>();
  const register = pathRegister(app);

  limitBodies(app);
  app.use("/v1/admin/*", async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) return c.json({ error: "Sign in required" }, 401);

    if (!(await accounts.isAdmin(session.user.id)))
      return c.json({ error: "Only admins can do this" }, 403);
    c.set("adminId", session.user.id);

    return next();
  });

  const findUser = async (id: string) => {
    const user = await adapter.findOne<StoredUser>({
      model: "user",
      where: [{ field: "id", value: id }],
    });

    if (!user) throw new HTTPException(404, { message: "No such user" });

    return user;
  };

  register(routes.adminUsers, async (c) => {
    const users = await adapter.findMany<StoredUser>({
      model: "user",
      sortBy: { field: "createdAt", direction: "asc" },
    });

    return c.json({ users: users.map(userOf) }, 200);
  });

  register(routes.setUserRole, async (c) => {
    const { id } = c.req.valid("param");
    const { role } = c.req.valid("json");
    const user = await findUser(id);

    if (
      role === "user" &&
      user.role === ADMIN_ROLE &&
      (await adminCount(adapter)) <= 1
    )
      return c.json({ error: "The server needs at least one admin" }, 409);
    await auth.api.setRole({
      body: { userId: id, role },
      headers: c.req.raw.headers,
    });

    return c.json(userOf(await findUser(id)), 200);
  });

  register(routes.removeUser, async (c) => {
    const { id } = c.req.valid("param");

    if (id === c.get("adminId"))
      return c.json({ error: "You can't remove your own account" }, 409);
    await findUser(id);
    await auth.api.removeUser({
      body: { userId: id },
      headers: c.req.raw.headers,
    });
    await options.removeAccount(id);

    return c.body(null, 204);
  });

  register(routes.invites, async (c) => {
    const pending = await invites.pending();

    return c.json(
      {
        invites: pending.map((invite) => ({
          id: invite.id,
          createdAt: invite.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  register(routes.createInvite, async (c) => {
    const { id, token } = await invites.create(c.get("adminId"));
    const url = new URL("/connect", options.origin());

    url.searchParams.set("invite", token);

    return c.json(
      { id, createdAt: new Date().toISOString(), url: url.href },
      200,
    );
  });

  register(routes.revokeInvite, async (c) => {
    if (!(await invites.revoke(c.req.valid("param").id)))
      return c.json({ error: "No such invite" }, 404);

    return c.body(null, 204);
  });

  register(routes.outdatedWorkspaces, async (c) =>
    c.json({ workspaces: await options.outdatedWorkspaces() }, 200),
  );

  register(routes.serverSettings, (c) => c.json(settings.get(), 200));

  register(routes.updateServerSettings, async (c) =>
    c.json(await settings.update(c.req.valid("json")), 200),
  );

  app.onError(handleApiError);

  return app;
}
