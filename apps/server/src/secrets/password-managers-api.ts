import { Effect, Predicate, Redacted } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { Conflict, InvalidInput, Unavailable } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { nowIso } from "../shared/time";
import { PasswordManagers } from "../password-managers/password-manager";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import type { PasswordManagerId } from "../contract/secrets";
import { SecretRepository } from "./secret-repository";
import { SecretValues } from "./secret-values";

type PasswordManagerServices =
  | PasswordManagers
  | PasswordManagerRepository
  | SecretRepository
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
    usedBy: yield* SecretRepository.use((secrets) => secrets.usedBy(id)),
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
  const using = yield* SecretRepository.use((secrets) => secrets.usedBy(id));

  if (using.length > 0)
    return yield* new Conflict({
      message: `${using.length} secret${using.length === 1 ? "" : "s"} still read from this password manager`,
    });

  yield* PasswordManagerRepository.use((repository) => repository.delete(id));
  yield* SecretValues.use((values) => values.disconnect(id));
});

/** The account's password managers: listing them, connecting one with a token, and disconnecting one. */
export function registerPasswordManagerRoutes(options: {
  register: Register;
  run: Runner<PasswordManagerServices>;
}) {
  const { register, run } = options;

  register(routes.passwordManagers, (c) => c.json(run.runSync(list), 200));
  register(routes.connectPasswordManager, async (c) => {
    return c.json(
      await run.runPromise(
        connect(
          c.req.valid("param").id,
          Redacted.make(c.req.valid("json").token),
        ),
      ),
      200,
    );
  });
  register(routes.disconnectPasswordManager, async (c) => {
    await run.runPromise(disconnect(c.req.valid("param").id));

    return c.body(null, 204);
  });
}
