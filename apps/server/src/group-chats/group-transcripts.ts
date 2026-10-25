import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  type EntryId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { attachmentDigest } from "../shared/attachments";
import {
  GROUP_MESSAGE_KIND,
  groupMessageData,
  readTranscript,
  type GroupMessageData,
  type TranscriptPage,
} from "../bots/transcript";
import { InvalidInput, NotFound, Conflict } from "../shared/errors";

export type GroupPost = Omit<GroupMessageData, "requestId" | "timestamp">;

/** A group message with its place in the transcript. */
export type GroupEntry = GroupMessageData & { entry: number; entryId: string };

/** Each group chat's shared transcript: a Pi store of data entries that never calls a model. */
export class GroupTranscripts {
  private readonly harnesses = new Map<string, Promise<Harness>>();
  private closed = false;

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
  }

  private path(groupId: string) {
    return join(this.dataDir, `${groupId}.sqlite`);
  }

  private async open(groupId: string): Promise<Harness> {
    if (this.closed) throw new Error("Group transcripts are closed");
    const existing = this.harnesses.get(groupId);

    if (existing) return existing;
    const opening = this.openHarness(groupId);
    this.harnesses.set(groupId, opening);

    try {
      return await opening;
    } catch (error) {
      this.harnesses.delete(groupId);
      throw error;
    }
  }

  private async openHarness(groupId: string): Promise<Harness> {
    const storage = await openNodeSqliteStorage(this.path(groupId));

    try {
      return await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      );
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  /** Appends one message; a retried request ID returns the entry it already wrote. */
  async post(groupId: string, message: GroupPost, requestId: string) {
    return (await this.write(groupId, message, requestId)).entryId;
  }

  /** Like `post`, and tells whether this call wrote the entry or found it from an earlier one. */
  async write(
    groupId: string,
    message: GroupPost,
    requestId: string,
  ): Promise<{ entryId: string; created: boolean }> {
    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const data: GroupMessageData = {
      ...message,
      requestId,
      timestamp: Date.now(),
    };

    const submission = await root.submit(
      { type: "write", requestId, entry: { kind: GROUP_MESSAGE_KIND, data } },
      BACKGROUND_CONTEXT,
    );

    const settled = await submission.wait(BACKGROUND_CONTEXT);

    if (settled.type !== "write" || settled.status !== "done")
      throw new Error("The group message was not written");

    // Pi returns the earlier submission for a reused request ID without comparing its content.
    const page = await root.entries(
      {
        order: "ascending",
        minEntryId: settled.entry,
        maxEntryId: settled.entry,
      },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );

    const written = groupMessageData.safeParse(page.items[0]?.data);

    if (
      !written.success ||
      written.data.text !== message.text ||
      written.data.sender.kind !== message.sender.kind ||
      written.data.sender.agentId !== message.sender.agentId ||
      written.data.replyTo !== message.replyTo ||
      written.data.reaction !== message.reaction ||
      attachmentDigest(written.data.attachments ?? []) !==
        attachmentDigest(message.attachments ?? [])
    )
      throw new Conflict({
        message: "Request ID already used for a different message",
      });

    return {
      entryId: `${groupId}:${Number(settled.entry)}`,
      // An earlier call's entry carries that call's time.
      created: written.data.timestamp === data.timestamp,
    };
  }

  /** Messages after entry number `cursor`, oldest first. */
  async after(groupId: string, cursor: number): Promise<GroupEntry[]> {
    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);
    const found: GroupEntry[] = [];
    let page = undefined;

    do {
      page = await root.entries(
        // SAFETY: entry numbers are Pi entry IDs; the successor of the cursor starts the range.
        { order: "ascending", minEntryId: (cursor + 1) as EntryId },
        256,
        page?.next,
        BACKGROUND_CONTEXT,
      );

      for (const item of page.items) {
        const parsed = groupMessageData.safeParse(item.data);

        if (item.kind === GROUP_MESSAGE_KIND && parsed.success)
          found.push({
            ...parsed.data,
            entry: Number(item.id),
            entryId: `${groupId}:${Number(item.id)}`,
          });
      }
    } while (page.next);

    return found;
  }

  /** One message by its entry ID, or undefined when the group has no such message. */
  async message(groupId: string, entryId: string) {
    const prefix = `${groupId}:`;
    const entry = Number(entryId.slice(prefix.length));

    if (
      !entryId.startsWith(prefix) ||
      !Number.isSafeInteger(entry) ||
      entry < 1
    )
      return undefined;

    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const page = await root.entries(
      // SAFETY: a positive safe integer names a Pi entry ID.
      {
        order: "ascending",
        minEntryId: entry as EntryId,
        maxEntryId: entry as EntryId,
      },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );

    const item = page.items[0];
    const parsed = groupMessageData.safeParse(item?.data);

    return item?.kind === GROUP_MESSAGE_KIND && parsed.success
      ? { ...parsed.data, entry, entryId }
      : undefined;
  }

  /** The bytes of one of a message's attachments. */
  async attachment(groupId: string, entryId: string, index: number) {
    const item = (await this.message(groupId, entryId))?.attachments?.[index];

    if (!item) throw new NotFound({ message: "Attachment not found" });

    return { mimeType: item.mimeType, data: Buffer.from(item.data, "base64") };
  }

  /** The number of the newest entry, or 0 for an empty transcript. */
  async latest(groupId: string) {
    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const page = await root.entries(
      { order: "descending" },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );

    return page.items[0] ? Number(page.items[0].id) : 0;
  }

  async history(
    groupId: string,
    options: { before?: string | undefined; limit?: number | undefined } = {},
  ): Promise<TranscriptPage> {
    const harness = await this.open(groupId);

    try {
      return await readTranscript(harness, groupId, options);
    } catch (error) {
      throw new InvalidInput({
        message:
          error instanceof Error ? error.message : "Invalid history cursor",
      });
    }
  }

  async delete(groupId: string) {
    const pending = this.harnesses.get(groupId);
    this.harnesses.delete(groupId);

    if (pending) await (await pending).close(BACKGROUND_CONTEXT);

    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${this.path(groupId)}${suffix}`, { force: true });
  }

  async close() {
    this.closed = true;
    const harnesses = await Promise.allSettled(this.harnesses.values());
    await Promise.all(
      harnesses
        .filter((harness) => harness.status === "fulfilled")
        .map((harness) => harness.value.close(BACKGROUND_CONTEXT)),
    );
    this.harnesses.clear();
  }
}
