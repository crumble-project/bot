import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  type EntryId,
} from "@earendil-works/pi-durable";
import { mkdirSync } from "node:fs";
import { attachmentDigest } from "../shared/attachments";
import {
  GROUP_MESSAGE_ENTRY,
  groupMessageData,
  type GroupMessageData,
} from "../transcript/entries";
import { isOwnerOrigin } from "../transcript/origins";
import {
  entryAt,
  readTranscript,
  type PageOptions,
  type TranscriptPage,
} from "../transcript/transcript";
import { formatEntryId, parseEntryId } from "../shared/entry-ids";
import { NotFound, Conflict, REQUEST_ID_REUSED } from "../shared/errors";
import { HarnessFiles } from "../shared/harness-files";

export type GroupPost = Omit<GroupMessageData, "requestId" | "timestamp">;

export type GroupEntry = GroupMessageData & { entry: number; entryId: string };

export const senderLabel = (
  sender: { kind: string; name?: string | undefined } | undefined,
) => (isOwnerOrigin(sender) ? "Owner" : (sender?.name ?? "A bot"));

function samePost(written: GroupMessageData, message: GroupPost): boolean {
  return (
    written.text === message.text &&
    written.sender.kind === message.sender.kind &&
    written.sender.agentId === message.sender.agentId &&
    written.replyTo === message.replyTo &&
    written.reaction === message.reaction &&
    attachmentDigest(written.attachments ?? []) ===
      attachmentDigest(message.attachments ?? [])
  );
}

export class GroupTranscripts {
  private readonly files: HarnessFiles<{ harness: Harness }>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.files = new HarnessFiles(dataDir, "Group transcripts are closed");
  }

  private async open(groupId: string) {
    const { harness } = await this.files.get(groupId, async (storage) => ({
      harness: await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        BACKGROUND_CONTEXT,
      ),
    }));

    return harness;
  }

  async post(groupId: string, message: GroupPost, requestId: string) {
    return (await this.write(groupId, message, requestId)).entryId;
  }

  async write(
    groupId: string,
    message: GroupPost,
    requestId: string,
  ): Promise<{ entry: number; entryId: string; created: boolean }> {
    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const data: GroupMessageData = {
      ...message,
      requestId,
      timestamp: Date.now(),
    };

    const submission = await root.submit(
      { type: "write", requestId, entry: { kind: GROUP_MESSAGE_ENTRY, data } },
      BACKGROUND_CONTEXT,
    );

    const settled = await submission.wait(BACKGROUND_CONTEXT);

    if (settled.type !== "write" || settled.status !== "done")
      throw new Error("The group message was not written");

    // Pi returns the earlier submission for a reused request ID without comparing its content.
    const written = groupMessageData.safeParse(
      (await entryAt(root, Number(settled.entry)))?.data,
    );

    if (!written.success || !samePost(written.data, message))
      throw new Conflict({ message: REQUEST_ID_REUSED });

    return {
      entry: Number(settled.entry),
      entryId: formatEntryId(groupId, Number(settled.entry)),
      // An earlier call's entry carries that call's time.
      created: written.data.timestamp === data.timestamp,
    };
  }

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

        if (item.kind === GROUP_MESSAGE_ENTRY && parsed.success)
          found.push({
            ...parsed.data,
            entry: Number(item.id),
            entryId: formatEntryId(groupId, Number(item.id)),
          });
      }
    } while (page.next);

    return found;
  }

  async message(groupId: string, entryId: string) {
    const entry = parseEntryId(entryId, groupId);

    if (entry === "foreign" || entry === "malformed") return undefined;

    const root = await (await this.open(groupId)).root(BACKGROUND_CONTEXT);

    const item = await entryAt(root, entry);
    const parsed = groupMessageData.safeParse(item?.data);

    return item?.kind === GROUP_MESSAGE_ENTRY && parsed.success
      ? { ...parsed.data, entry, entryId }
      : undefined;
  }

  async attachment(groupId: string, entryId: string, index: number) {
    const item = (await this.message(groupId, entryId))?.attachments?.[index];

    if (!item) throw new NotFound({ message: "Attachment not found" });

    return { mimeType: item.mimeType, data: Buffer.from(item.data, "base64") };
  }

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
    options: PageOptions = {},
  ): Promise<TranscriptPage> {
    return readTranscript(await this.open(groupId), groupId, options);
  }

  delete(groupId: string) {
    return this.files.delete(groupId);
  }

  close() {
    return this.files.close();
  }
}
