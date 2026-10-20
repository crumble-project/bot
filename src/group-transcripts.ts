import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { AppError } from "./domain";
import {
  GROUP_MESSAGE_KIND,
  groupMessageData,
  readTranscript,
  type GroupMessageData,
  type MessageOrigin,
  type TranscriptPage,
} from "./transcript";

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
  async post(
    groupId: string,
    message: { text: string; sender: MessageOrigin },
    requestId: string,
  ): Promise<string> {
    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const data: GroupMessageData = {
      text: message.text,
      sender: message.sender,
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
      written.data.sender.agentId !== message.sender.agentId
    )
      throw new AppError(
        409,
        "Request ID already used for a different message",
      );

    return `${groupId}:${Number(settled.entry)}`;
  }

  async history(
    groupId: string,
    options: { before?: string; limit?: number } = {},
  ): Promise<TranscriptPage> {
    const harness = await this.open(groupId);

    try {
      return await readTranscript(harness, groupId, options);
    } catch (error) {
      throw new AppError(
        400,
        error instanceof Error ? error.message : "Invalid history cursor",
      );
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
