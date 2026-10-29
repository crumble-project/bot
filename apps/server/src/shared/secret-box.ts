import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { count } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "./product-database";
import {
  agentCredentials,
  credentialAuthorities,
  secrets,
} from "../credentials/schema";
import { passwordManagers } from "../password-managers/schema";
import { providerCredentials } from "../providers/schema";

export const MASTER_KEY_VARIABLE = "CRUMBLE_MASTER_KEY";

function seal(key: Buffer, value: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value), cipher.final()]);

  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64"))
    .join(":");
}

function open(key: Buffer, packed: string) {
  // SAFETY: seal always stores exactly three base64 segments: IV, auth tag, and ciphertext.
  const [iv, tag, data] = packed
    .split(":")
    .map((part) => Buffer.from(part, "base64")) as [Buffer, Buffer, Buffer];

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]);
}

function parseMasterKey(value: string) {
  const key = Buffer.from(value, "base64");

  if (key.length !== 32 || key.toString("base64") !== value.trim())
    throw new Error(`${MASTER_KEY_VARIABLE} must be 32 random bytes in base64`);

  return key;
}

function unwrap(masterKey: Buffer, path: string) {
  try {
    const key = open(masterKey, readFileSync(path, "utf8").trim());

    if (key.length === 32) return key;
  } catch {
    /* reported below */
  }

  throw new Error(
    `Credential encryption key cannot be unwrapped with ${MASTER_KEY_VARIABLE}; refusing to start the account`,
  );
}

function restrict(path: string) {
  try {
    chmodSync(path, 0o600);
  } catch {
    /* permissions are best effort on Windows */
  }
}

// A failed sync throws before the plain key is deleted, so it stays recoverable.
function syncDirectory(path: string) {
  if (process.platform === "win32") return; // Windows can't open a directory to sync it

  const fd = openSync(path, "r");

  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Synced and renamed into place, so a crash leaves the old file or the whole new one, never a partial key.
function writeSecret(path: string, data: string | Buffer) {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);

  try {
    writeSync(fd, Buffer.from(data));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }

  closeSync(fd);
  restrict(temporary);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

type KeyFiles = { dataDir: string; keyPath: string; wrappedPath: string };

/** The account's key without a master key: `.secret.key`, created on first start. */
function plainKey(keyPath: string, exists: boolean) {
  if (exists) {
    restrict(keyPath);

    return readFileSync(keyPath);
  }

  const fresh = randomBytes(32);
  writeSecret(keyPath, fresh);

  return fresh;
}

/** Deletes `.secret.key` once the wrapped key is on disk. */
function removePlainKey({ dataDir, keyPath }: KeyFiles) {
  syncDirectory(dataDir);
  rmSync(keyPath);
  syncDirectory(dataDir);
}

/** A start that stopped mid-migration leaves both files; the plain one may go only if they agree. */
function unwrapExisting(
  masterKey: Buffer,
  { wrappedPath }: KeyFiles,
  plain: Buffer | undefined,
) {
  const unwrapped = unwrap(masterKey, wrappedPath);

  if (plain && !plain.equals(unwrapped))
    throw new Error(
      "Credential encryption key differs between .secret.key and .secret.key.wrapped; refusing to start the account",
    );

  return unwrapped;
}

/** Wraps the plain key, or a new one, and checks the wrapped file reads back the same. */
function wrapNew(
  masterKey: Buffer,
  { wrappedPath }: KeyFiles,
  plain: Buffer | undefined,
) {
  const accountKey = plain ?? randomBytes(32);
  writeSecret(wrappedPath, seal(masterKey, accountKey));

  if (!unwrap(masterKey, wrappedPath).equals(accountKey))
    throw new Error(
      "Credential encryption key did not survive wrapping; refusing to start the account",
    );

  return accountKey;
}

/** The account's key with a master key: from `.secret.key.wrapped`, wrapping and deleting a plain `.secret.key`. */
function wrappedKey(
  files: KeyFiles,
  masterKey: Buffer,
  exists: { plain: boolean; wrapped: boolean },
) {
  const plain = exists.plain ? readFileSync(files.keyPath) : undefined;

  const key = exists.wrapped
    ? unwrapExisting(masterKey, files, plain)
    : wrapNew(masterKey, files, plain);

  if (plain) removePlainKey(files);

  return key;
}

/**
 * Encrypts values at rest with the account's key (AES-256-GCM). The key lives in `.secret.key`,
 * or in `.secret.key.wrapped`, sealed with `CRUMBLE_MASTER_KEY`, when that variable is set.
 */
export class SecretBox extends Context.Service<
  SecretBox,
  {
    readonly encrypt: (value: string) => string;
    readonly decrypt: (packed: string) => string;
    /** Decrypts a secret's stored value; one read from a password manager has none, and reading it here is a defect. */
    readonly decryptStored: (packed: string | null) => string;
  }
>()("crumble/shared/SecretBox") {
  static layer(
    dataDir: string,
    masterKeyValue: string | undefined = process.env[MASTER_KEY_VARIABLE],
  ) {
    return Layer.effect(
      SecretBox,
      Effect.gen(function* () {
        const db = yield* ProductDatabase;
        const keyPath = join(dataDir, ".secret.key");
        const wrappedPath = join(dataDir, ".secret.key.wrapped");

        const masterKey = masterKeyValue
          ? yield* Effect.sync(() => parseMasterKey(masterKeyValue))
          : undefined;

        const keyExists = existsSync(keyPath);
        const wrappedExists = existsSync(wrappedPath);

        if (wrappedExists && !masterKey)
          return yield* Effect.die(
            new Error(
              `Credential encryption key is wrapped; set ${MASTER_KEY_VARIABLE} to start the account`,
            ),
          );

        if (!keyExists && !wrappedExists) {
          const encrypted = yield* Effect.forEach(
            [
              secrets,
              providerCredentials,
              agentCredentials,
              credentialAuthorities,
              passwordManagers,
            ],
            (table) => db.select({ n: count() }).from(table),
          ).pipe(Effect.orDie);

          // A new key cannot read what an old one encrypted; refusing keeps those values recoverable.
          if (encrypted.some(([row]) => (row?.n ?? 0) > 0))
            return yield* Effect.die(
              new Error(
                "Credential encryption key is missing; refusing to overwrite it",
              ),
            );
        }

        const files = { dataDir, keyPath, wrappedPath };

        const key = yield* Effect.sync(() =>
          masterKey
            ? wrappedKey(files, masterKey, {
                plain: keyExists,
                wrapped: wrappedExists,
              })
            : plainKey(keyPath, keyExists),
        );

        const encrypt = (value: string) =>
          seal(key, Buffer.from(value, "utf8"));

        const decrypt = (packed: string) => open(key, packed).toString("utf8");

        const decryptStored = (packed: string | null) => {
          if (packed === null)
            throw new Error(
              "This secret comes from a password manager, so it has no stored value",
            );

          return decrypt(packed);
        };

        return SecretBox.of({ encrypt, decrypt, decryptStored });
      }),
    );
  }
}
