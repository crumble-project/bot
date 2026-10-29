import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { PasswordManagerRepository } from "./password-manager-repository";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Opens an account's product database with the repository, runs `use`, and closes it. */
const withRepository = <A, E>(
  use: (dir: string) => Effect.Effect<A, E, PasswordManagerRepository>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "password-managers-"));
  dirs.push(dir);

  const runtime = ManagedRuntime.make(
    PasswordManagerRepository.layer.pipe(
      Layer.provideMerge(SecretBox.layer(dir, [], undefined)),
      Layer.provideMerge(ProductDatabase.layer(dir)),
    ),
  );

  return runtime.runPromise(use(dir)).finally(() => runtime.dispose());
};

/** Runs SQL on the account's database beside the repository's connection, with foreign keys enforced as the server does. */
const sql = (dir: string, statement: string) => {
  const db = new Database(join(dir, "store.sqlite"));

  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run(statement);
  } finally {
    db.close();
  }
};

describe("PasswordManagerRepository", () => {
  test("stores the token encrypted and lists connections without it", async () => {
    const result = await withRepository((dir) =>
      Effect.gen(function* () {
        const repository = yield* PasswordManagerRepository;

        yield* repository.save("1password", Redacted.make("ops_token"), "t1");

        const stored = new Database(join(dir, "store.sqlite"), {
          readonly: true,
        });

        const raw = stored.query("SELECT token FROM password_managers").get();
        stored.close();

        return {
          raw,
          list: yield* repository.list,
          token: yield* repository.token("1password"),
          missing: yield* repository.token("bitwarden"),
        };
      }),
    );

    expect(JSON.stringify(result.raw)).not.toContain("ops_token");
    expect(result.list).toEqual([{ id: "1password", connectedAt: "t1" }]);
    expect(result.token && Redacted.value(result.token)).toBe("ops_token");
    expect(result.missing).toBeUndefined();
  });

  test("refuses to disconnect while a secret reads from it", async () => {
    const result = await withRepository((dir) =>
      Effect.gen(function* () {
        const repository = yield* PasswordManagerRepository;

        yield* repository.save("1password", Redacted.make("ops_token"), "t1");
        sql(
          dir,
          "INSERT INTO credentials (key, password_manager, reference) VALUES ('mcp:server', '1password', 'op://v/i/f')",
        );

        const refused = yield* Effect.flip(repository.delete("1password"));
        const usedBy = yield* repository.usedBy("1password");

        sql(dir, "DELETE FROM credentials WHERE key = 'mcp:server'");

        return {
          refused: refused._tag,
          usedBy,
          deleted: yield* repository.delete("1password"),
        };
      }),
    );

    expect(result).toEqual({
      refused: "Conflict",
      usedBy: [{ kind: "secret", key: "mcp:server" }],
      deleted: true,
    });
  });

  test("the database allows exactly one source per secret, and no OAuth reference", async () => {
    const rejects = await withRepository((dir) =>
      Effect.gen(function* () {
        yield* (yield* PasswordManagerRepository).save(
          "1password",
          Redacted.make("ops_token"),
          "t1",
        );

        const rejected = (statement: string) => {
          try {
            sql(dir, statement);

            return false;
          } catch {
            return true;
          }
        };

        return {
          both: rejected(
            "INSERT INTO credentials (key, value, password_manager, reference) VALUES ('a', 'sealed', '1password', 'op://v/i/f')",
          ),
          neither: rejected("INSERT INTO credentials (key) VALUES ('b')"),
          unknownManager: rejected(
            "INSERT INTO credentials (key, password_manager, reference) VALUES ('c', 'bitwarden', 'id')",
          ),
          oauthReference: rejected(
            "INSERT INTO provider_credentials (provider, type, password_manager, reference) VALUES ('openai', 'oauth', '1password', 'op://v/i/f')",
          ),
          apiKeyReference: rejected(
            "INSERT INTO provider_credentials (provider, type, password_manager, reference) VALUES ('anthropic', 'api_key', '1password', 'op://v/i/f')",
          ),
        };
      }),
    );

    expect(rejects).toEqual({
      both: true,
      neither: true,
      unknownManager: true,
      oauthReference: true,
      apiKeyReference: false,
    });
  });
});
