import { expect, test } from "bun:test";
import { Glob } from "bun";
import { encryptedTables } from "./product-layer";

test("every table a repository encrypts into guards the account's key", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const listed = new Set(Object.keys(encryptedTables));
  const encrypting: string[] = [];

  for await (const file of new Glob("**/*.ts").scan(root)) {
    if (file.endsWith(".test.ts") || file.startsWith("shared/secret-box"))
      continue;
    const source = await Bun.file(`${root}${file}`).text();

    if (!/\.encrypt\(/.test(source)) continue;
    encrypting.push(file);

    const written = [...source.matchAll(/\.(?:insert|update)\((\w+)\)/g)].map(
      (match) => match[1]!,
    );

    expect([file, written.some((table) => listed.has(table))]).toEqual([
      file,
      true,
    ]);
  }

  expect(encrypting).not.toBeEmpty();
});
