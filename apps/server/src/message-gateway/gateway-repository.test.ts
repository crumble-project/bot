import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { ProductDatabase } from "../shared/product-database";
import {
  GATEWAY_HISTORY_RETENTION_MS,
  GATEWAY_RECEIPT_TTL_MS,
  GatewayRepository,
} from "./gateway-repository";
import { gatewayReceipts, gatewaySentMessages } from "./schema";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "crumble-gateway-repository-"));

  const runtime = ManagedRuntime.make(
    GatewayRepository.layer.pipe(
      Layer.provideMerge(ProductDatabase.layer(folder)),
    ),
  );

  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(folder, { recursive: true, force: true });
  });
  const repository = await runtime.runPromise(GatewayRepository);

  const rows = () =>
    runtime.runPromise(
      ProductDatabase.use((db) =>
        db
          .select()
          .from(gatewayReceipts)
          .where(eq(gatewayReceipts.adapterId, "platform"))
          .pipe(Effect.orDie),
      ),
    );

  const mappings = () =>
    runtime.runPromise(
      ProductDatabase.use((db) =>
        db.select().from(gatewaySentMessages).pipe(Effect.orDie),
      ),
    );

  return { runtime, repository, rows, mappings, folder };
}

const receipt = {
  adapterId: "platform",
  messageId: "input",
  channelId: "channel",
  senderId: "owner",
  isDirectMessage: false,
  botId: "bot",
  requestId: "original-request",
  text: "private input",
  executionId: "execution",
  chunks: ["private output"],
  sent: ["external-message"],
  state: "pending" as const,
};

test("terminal receipts scrub payloads while preserving indexed reply routing and deduplication", async () => {
  const f = await fixture();
  await Effect.runPromise(f.repository.insert(receipt));
  const [stored] = await f.rows();
  await Effect.runPromise(f.repository.save({ ...stored!, state: "done" }));
  expect(await f.rows()).toEqual([
    expect.objectContaining({
      text: "",
      chunks: null,
      sent: [],
      requestId: "original-request",
    }),
  ]);
  expect(
    await Effect.runPromise(
      f.repository.replyBot("platform", "channel", "external-message"),
    ),
  ).toBe("bot");
  expect(
    await Effect.runPromise(
      f.repository.replyBot("other", "channel", "external-message"),
    ),
  ).toBeNull();
  expect(
    await Effect.runPromise(
      f.repository.replyBot("platform", "other", "external-message"),
    ),
  ).toBeNull();
  expect(await Effect.runPromise(f.repository.insert(receipt))).toBe(false);
  const db = new Database(join(f.folder, "store.sqlite"), { readonly: true });

  const plan = db
    .query(
      "EXPLAIN QUERY PLAN SELECT bot_id FROM gateway_sent_messages WHERE adapter_id = 'platform' AND channel_id = 'channel' AND external_message_id = 'external-message'",
    )
    .all();

  expect(JSON.stringify(plan)).toContain(
    "SEARCH gateway_sent_messages USING INDEX",
  );
  expect(JSON.stringify(plan)).not.toContain("SCAN");
  db.close();
});

test("chunk progress and reply mapping commit together and survive reopening", async () => {
  const f = await fixture();
  await Effect.runPromise(f.repository.insert({ ...receipt, sent: [] }));
  const [stored] = await f.rows();
  expect(stored!.expiresAt - stored!.createdAt).toBe(GATEWAY_RECEIPT_TTL_MS);
  const db = new Database(join(f.folder, "store.sqlite"));
  db.run(
    "CREATE TRIGGER reject_mapping BEFORE INSERT ON gateway_sent_messages BEGIN SELECT RAISE(ABORT, 'mapping unavailable'); END",
  );

  const failed = await Effect.runPromise(
    Effect.exit(f.repository.save({ ...stored!, sent: ["first"] })),
  );

  expect(Exit.isFailure(failed)).toBe(true);
  expect((await f.rows())[0]!.sent).toEqual([]);
  expect(await f.mappings()).toEqual([]);
  db.run("DROP TRIGGER reject_mapping");
  db.close();
  await Effect.runPromise(
    f.repository.save({
      ...stored!,
      sent: ["first"],
      attemptCount: 2,
      nextAttemptAt: 123,
    }),
  );
  expect((await f.rows())[0]).toMatchObject({
    sent: ["first"],
    chunks: receipt.chunks,
    requestId: receipt.requestId,
    attemptCount: 2,
    nextAttemptAt: 123,
  });
  expect(await f.mappings()).toEqual([
    expect.objectContaining({
      externalMessageId: "first",
      botId: "bot",
      expiresAt: null,
    }),
  ]);

  const reopened = ManagedRuntime.make(
    GatewayRepository.layer.pipe(
      Layer.provideMerge(ProductDatabase.layer(f.folder)),
    ),
  );

  try {
    expect(
      await reopened.runPromise(
        GatewayRepository.use((repository) => repository.pending),
      ),
    ).toEqual(await f.rows());
    expect(
      await reopened.runPromise(
        GatewayRepository.use((repository) =>
          repository.replyBot("platform", "channel", "first"),
        ),
      ),
    ).toBe("bot");
  } finally {
    await reopened.dispose();
  }
});

test("retention prunes terminal receipts and mappings at the boundary while preserving pending work", async () => {
  const f = await fixture();
  const finishedAt = 100_000;
  await Effect.runPromise(
    f.repository.insert({ ...receipt, messageId: "done" }),
  );
  await Effect.runPromise(
    f.repository.insert({
      ...receipt,
      messageId: "failed",
      sent: ["failed-output"],
    }),
  );
  await Effect.runPromise(
    f.repository.insert({
      ...receipt,
      messageId: "pending",
      createdAt: 1,
      expiresAt: 2,
    }),
  );

  for (const row of await f.rows()) {
    if (row.messageId === "pending") continue;
    await Effect.runPromise(
      f.repository.save({
        ...row,
        state: row.messageId === "failed" ? "failed" : "done",
        finishedAt,
        failedAt: row.messageId === "failed" ? finishedAt : null,
      }),
    );
  }

  expect(await Effect.runPromise(f.repository.failedCount("platform"))).toBe(1);
  expect(await Effect.runPromise(f.repository.failedCount("other"))).toBe(0);
  await Effect.runPromise(
    f.repository.pruneGatewayHistory(
      finishedAt + GATEWAY_HISTORY_RETENTION_MS - 1,
    ),
  );
  expect(await f.rows()).toHaveLength(3);
  expect(await f.mappings()).toHaveLength(2);
  await Effect.runPromise(
    f.repository.pruneGatewayHistory(finishedAt + GATEWAY_HISTORY_RETENTION_MS),
  );
  expect((await f.rows()).map((row) => row.messageId)).toEqual(["pending"]);
  expect(await f.mappings()).toEqual([]);
  expect(await Effect.runPromise(f.repository.failedCount("platform"))).toBe(0);
  expect(
    await Effect.runPromise(
      f.repository.insert({ ...receipt, messageId: "done" }),
    ),
  ).toBe(true);
});

test("cooldowns persist adapter and channel scope, preserve longer deadlines, and expire", async () => {
  const f = await fixture();
  await Effect.runPromise(f.repository.defer("platform", "channel", 200));
  await Effect.runPromise(f.repository.defer("platform", "channel", 100));
  await Effect.runPromise(f.repository.defer("platform", null, 150));
  expect(
    await Effect.runPromise(f.repository.cooldown("platform", "channel")),
  ).toBe(200);
  expect(
    await Effect.runPromise(f.repository.cooldown("platform", "other")),
  ).toBe(150);
  expect(
    await Effect.runPromise(f.repository.cooldown("other", "channel")),
  ).toBe(0);

  const reopened = ManagedRuntime.make(
    GatewayRepository.layer.pipe(
      Layer.provideMerge(ProductDatabase.layer(f.folder)),
    ),
  );

  try {
    expect(
      await reopened.runPromise(
        GatewayRepository.use((repository) =>
          repository.cooldown("platform", "channel"),
        ),
      ),
    ).toBe(200);
  } finally {
    await reopened.dispose();
  }

  await Effect.runPromise(f.repository.pruneGatewayHistory(150));
  expect(
    await Effect.runPromise(f.repository.cooldown("platform", "other")),
  ).toBe(0);
  expect(
    await Effect.runPromise(f.repository.cooldown("platform", "channel")),
  ).toBe(200);
  await Effect.runPromise(f.repository.pruneGatewayHistory(200));
  expect(
    await Effect.runPromise(f.repository.cooldown("platform", "channel")),
  ).toBe(0);
});
