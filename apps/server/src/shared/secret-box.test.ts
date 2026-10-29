import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { ProductDatabase } from "./product-database";
import { SecretBox } from "./secret-box";

const dirs: string[] = [];

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "secret-box-"));
  dirs.push(dir);

  return dir;
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const masterKey = () => randomBytes(32).toString("base64");

/** Opens the account's box, runs `use` on it, and closes it. */
const withBox = <A>(
  dir: string,
  key: string | undefined,
  use: (box: SecretBox["Service"]) => A,
) => {
  // Built in this fiber, like the test Store, so runSync outlasts the migration's scheduler yields.
  const scope = Scope.makeUnsafe();

  try {
    const context = Effect.runSync(
      Layer.buildWithScope(
        SecretBox.layer(dir, [], key).pipe(
          Layer.provideMerge(ProductDatabase.layer(dir)),
        ),
        scope,
      ),
    );

    return use(Context.get(context, SecretBox));
  } finally {
    Effect.runSync(Scope.close(scope, Exit.void));
  }
};

const files = (dir: string) => ({
  plain: existsSync(join(dir, ".secret.key")),
  wrapped: existsSync(join(dir, ".secret.key.wrapped")),
});

describe("SecretBox", () => {
  test("without a master key stores the plain key as before", () => {
    const dir = make();
    const packed = withBox(dir, undefined, (box) => box.encrypt("value"));

    expect(files(dir)).toEqual({ plain: true, wrapped: false });
    expect(withBox(dir, undefined, (box) => box.decrypt(packed))).toBe("value");
  });

  test("a new account with a master key stores only the wrapped key", () => {
    const dir = make();
    const key = masterKey();
    const packed = withBox(dir, key, (box) => box.encrypt("value"));

    expect(files(dir)).toEqual({ plain: false, wrapped: true });
    expect(
      readFileSync(join(dir, ".secret.key.wrapped"), "utf8"),
    ).not.toContain(packed);
    expect(withBox(dir, key, (box) => box.decrypt(packed))).toBe("value");
  });

  test("migrates a plain key to a wrapped one that reads old values", () => {
    const dir = make();
    const packed = withBox(dir, undefined, (box) => box.encrypt("value"));
    const key = masterKey();

    expect(withBox(dir, key, (box) => box.decrypt(packed))).toBe("value");
    expect(files(dir)).toEqual({ plain: false, wrapped: true });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
    expect(withBox(dir, key, (box) => box.decrypt(packed))).toBe("value");
  });

  test("keeps the plain key when the wrapped key's directory entry can't be synced", () => {
    const dir = make();
    const packed = withBox(dir, undefined, (box) => box.encrypt("value"));
    const key = masterKey();
    const fsync = fs.fsyncSync;
    let calls = 0;

    // The first sync is the wrapped file; the second is its directory entry.
    const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 2) throw new Error("EIO: i/o error, fsync");
      fsync(fd);
    });

    try {
      expect(() => withBox(dir, key, () => undefined)).toThrow(/EIO/);
    } finally {
      sync.mockRestore();
    }

    expect(files(dir).plain).toBe(true);
    expect(withBox(dir, key, (box) => box.decrypt(packed))).toBe("value");
    expect(files(dir)).toEqual({ plain: false, wrapped: true });
  });

  test("refuses a wrong master key and keeps the wrapped key", () => {
    const dir = make();
    withBox(dir, masterKey(), () => undefined);
    const wrapped = readFileSync(join(dir, ".secret.key.wrapped"), "utf8");

    expect(() => withBox(dir, masterKey(), () => undefined)).toThrow(
      /CRUMBLE_MASTER_KEY/,
    );
    expect(readFileSync(join(dir, ".secret.key.wrapped"), "utf8")).toBe(
      wrapped,
    );
    expect(files(dir)).toEqual({ plain: false, wrapped: true });
  });

  test("refuses to start a wrapped account without the master key", () => {
    const dir = make();
    withBox(dir, masterKey(), () => undefined);

    expect(() => withBox(dir, undefined, () => undefined)).toThrow(
      /CRUMBLE_MASTER_KEY/,
    );
    expect(files(dir)).toEqual({ plain: false, wrapped: true });
  });

  test("rejects a master key that isn't 32 bytes of base64", () => {
    expect(() =>
      withBox(make(), randomBytes(16).toString("base64"), () => undefined),
    ).toThrow(/CRUMBLE_MASTER_KEY/);
  });
});
