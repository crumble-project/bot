import type { BotLookup } from "../bot-ports/bot-lookup";

type SecretCall = { req: { param(name: "id" | "name"): string } };

type EmptyAnswer<R> = { body(data: null, status: 204): R };

/** Routes on one of a bot's secrets: an unknown bot stops them before `act` runs. `done` answers 204 once it has. */
export const secretRoutes = (service: BotLookup) => {
  const secret =
    <C extends SecretCall, T>(act: (id: string, name: string, c: C) => T) =>
    (c: C) => {
      const id = c.req.param("id");

      service.agent(id);

      return act(id, c.req.param("name"), c);
    };

  const done = <A>(act: (id: string, name: string) => Promise<A>) =>
    secret(
      async <R>(id: string, name: string, c: EmptyAnswer<R> & SecretCall) => {
        await act(id, name);

        return c.body(null, 204);
      },
    );

  return { secret, done };
};
