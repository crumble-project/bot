import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../test/support/store";
import { Library } from "./library";
import type { LibraryRef } from "./library-repository";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

for (const sameLibrary of [true, false]) {
  test(`different MIME uploads preserve extracted text in ${sameLibrary ? "the same" : "another"} library`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "library-text-"));
    const store = new Store(dir);
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanups.push(() => store.close());

    const bot = store.createAgent({
      name: "Ada",
      description: "",
      instructions: "",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    const group = store.createGroupChat({ name: "Group", memberIds: [bot.id] });
    const library: LibraryRef = { kind: "bot", agentId: bot.id };

    const other: LibraryRef = sameLibrary
      ? library
      : { kind: "group", groupId: group.id };

    const bytes = await Bun.file(
      new URL("../../test/fixtures/text.pdf", import.meta.url),
    ).arrayBuffer();

    const upload = (ref: LibraryRef, mimeType: string) =>
      store.runtime.runPromise(
        Library.use((service) =>
          service.upload(ref, {
            name: "test.pdf",
            mimeType,
            body: new Blob([bytes]).stream(),
          }),
        ),
      );

    const original = await upload(library, "application/pdf");

    const entries = await store.runtime.runPromise(
      Library.use((service) => service.entries(library, [original.file.id])),
    );

    const entry = entries.get(original.file.id)!;

    const before = await store.runtime.runPromise(
      Library.use((service) => service.text(entry)),
    );

    expect(before).toContain("Crumble library fixture");
    const duplicate = await upload(other, "text/plain");
    expect(duplicate.existed).toBe(sameLibrary);

    const after = await store.runtime.runPromise(
      Library.use((service) => service.text(entry)),
    );

    expect(after).toBe(before);

    if (!sameLibrary) {
      const otherEntries = await store.runtime.runPromise(
        Library.use((service) => service.entries(other, [duplicate.file.id])),
      );

      const plain = await store.runtime.runPromise(
        Library.use((service) =>
          service.text(otherEntries.get(duplicate.file.id)!),
        ),
      );

      expect(plain).toBe(new TextDecoder().decode(bytes));
    }
  });
}
