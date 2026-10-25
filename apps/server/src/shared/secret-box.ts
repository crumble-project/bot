import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { count } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "./product-database";
import {
  agentCredentials,
  credentialAuthorities,
  secrets,
} from "../credentials/schema";
import { providerCredentials } from "../providers/schema";

/** Encrypts values at rest with the account's key in `.secret.key` (AES-256-GCM). */
export class SecretBox extends Context.Service<
  SecretBox,
  {
    readonly encrypt: (value: string) => string;
    readonly decrypt: (packed: string) => string;
  }
>()("crumble/shared/SecretBox") {
  static layer(dataDir: string) {
    return Layer.effect(
      SecretBox,
      Effect.gen(function* () {
        const db = yield* ProductDatabase;
        const keyPath = join(dataDir, ".secret.key");
        const keyExists = existsSync(keyPath);

        if (!keyExists) {
          const encrypted = yield* Effect.forEach(
            [
              secrets,
              providerCredentials,
              agentCredentials,
              credentialAuthorities,
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

        const key = keyExists ? readFileSync(keyPath) : randomBytes(32);

        if (!keyExists) writeFileSync(keyPath, key, { mode: 0o600 });

        try {
          chmodSync(keyPath, 0o600);
        } catch {
          /* permissions are best effort on Windows */
        }

        const encrypt = (value: string) => {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);

          const data = Buffer.concat([
            cipher.update(value, "utf8"),
            cipher.final(),
          ]);

          return [iv, cipher.getAuthTag(), data]
            .map((part) => part.toString("base64"))
            .join(":");
        };

        const decrypt = (packed: string) => {
          // SAFETY: encrypt always stores exactly three base64 segments: IV, auth tag, and ciphertext.
          const [iv, tag, data] = packed
            .split(":")
            .map((part) => Buffer.from(part, "base64")) as [
            Buffer,
            Buffer,
            Buffer,
          ];

          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(tag);

          return Buffer.concat([
            decipher.update(data),
            decipher.final(),
          ]).toString("utf8");
        };

        return SecretBox.of({ encrypt, decrypt });
      }),
    );
  }
}
