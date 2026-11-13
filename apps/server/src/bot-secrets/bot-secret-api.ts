import type { Effect } from "effect";
import type { BotLookup } from "../bot-ports/bot-lookup";

type SecretCall = { req: { param(name: "id" | "name"): string } };

type EmptyAnswer<R> = { body(data: null, status: 204): R };

/** Routes on one of a bot's secrets: an unknown bot stops them before `act` runs. `done` answers 204 once it has. */
export const secretRoutes = (service: BotLookup) => {
  const secret = <C extends SecretCall, S, T>(
    act: (
      id: string,
      name: string,
      c: C,
    ) => Generator<Effect.Effect<unknown, unknown, S>, T, never>,
  ) =>
    function* (c: C): Generator<Effect.Effect<unknown, unknown, S>, T, never> {
      const id = c.req.param("id");

      service.agent(id);

      return yield* act(id, c.req.param("name"), c);
    };

  const done = <A, E, R>(
    act: (id: string, name: string) => Effect.Effect<A, E, R>,
  ) =>
    secret(function* <Res>(
      id: string,
      name: string,
      c: EmptyAnswer<Res> & SecretCall,
    ) {
      yield* act(id, name);

      return c.body(null, 204);
    });

  return { secret, done };
};
