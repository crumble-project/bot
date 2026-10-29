import { Effect, Predicate, Redacted } from "effect";
import { passwordManagerTokenInput, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { InvalidInput, Unavailable } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { nowIso } from "../shared/time";
import { PasswordManagers } from "./password-manager";
import { PasswordManagerRepository } from "./password-manager-repository";
import {
  passwordManagerIdInput,
  type PasswordManagerId,
} from "../shared/domain";
import { SecretValues } from "./secret-values";

type PasswordManagerServices =
  | PasswordManagers
  | PasswordManagerRepository
  | SecretValues;

const describe = Effect.fnUntraced(function* (id: PasswordManagerId) {
  const managers = yield* PasswordManagers;
  const repository = yield* PasswordManagerRepository;

  const connection = (yield* repository.list).find(
    (connection) => connection.id === id,
  );

  return {
    id,
    name: managers.name(id),
    connected: connection !== undefined,
    connectedAt: connection?.connectedAt ?? null,
    usedBy: yield* repository.usedBy(id),
  };
});

const list = Effect.gen(function* () {
  const managers = yield* PasswordManagers;

  return {
    passwordManagers: yield* Effect.forEach(managers.ids, describe),
  };
});

/** Signs in once to check the token, then saves it and drops the client and values read with the old one. */
const connect = Effect.fnUntraced(function* (
  id: PasswordManagerId,
  token: Redacted.Redacted,
) {
  const managers = yield* PasswordManagers;
  const name = managers.name(id);

  yield* Effect.scoped(managers.connect(id, token)).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, "PasswordManagerTokenRejected")
        ? new InvalidInput({ message: `${name} ${error.message}` })
        : new Unavailable({ message: `${name} ${error.message}` }),
    ),
  );

  yield* PasswordManagerRepository.use((repository) =>
    nowIso.pipe(Effect.flatMap((at) => repository.save(id, token, at))),
  );
  yield* SecretValues.use((values) => values.disconnect(id));

  return yield* describe(id);
});

const disconnect = Effect.fnUntraced(function* (id: PasswordManagerId) {
  yield* PasswordManagerRepository.use((repository) => repository.delete(id));
  yield* SecretValues.use((values) => values.disconnect(id));
});

/** The account's password managers: listing them, connecting one with a token, and disconnecting one. */
export function registerPasswordManagerRoutes(options: {
  register: Register;
  run: Runner<PasswordManagerServices>;
}) {
  const { register, run } = options;
  const idOf = (param: string) => passwordManagerIdInput.parse(param);

  register(routes.passwordManagers, (c) => c.json(run.runSync(list), 200));
  register(routes.connectPasswordManager, async (c) => {
    const id = idOf(c.req.param("id"));
    const input = passwordManagerTokenInput.parse(await c.req.json());

    return c.json(
      await run.runPromise(connect(id, Redacted.make(input.token))),
      200,
    );
  });
  register(routes.disconnectPasswordManager, async (c) => {
    await run.runPromise(disconnect(idOf(c.req.param("id"))));

    return c.body(null, 204);
  });
}
