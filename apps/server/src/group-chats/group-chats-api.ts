import {
  routes,
  attachmentIndex,
  groupMessageInput,
  historyInput,
  snapshotInput,
} from "../contract/api-contract";
import type { Register } from "../contract/route";
import { snapshotSender, streamEvents } from "../shared/event-stream";
import { groupChatInput } from "../shared/domain";
import { Unavailable } from "../shared/errors";
import type { GroupChatsAccess } from "./group-chats";

type GroupChatRoutesOptions = {
  register: Register;
  /** Group chats; their routes answer 503 without it. */
  groupChats?: GroupChatsAccess;
};

/** Group chats are optional, so every route asks for them and answers 503 when the server has none. */
const requireGroupChats = (groupChats: GroupChatsAccess | undefined) => {
  if (!groupChats)
    throw new Unavailable({ message: "Group chats are unavailable" });

  return groupChats;
};

/** Listing, creating, editing, and deleting group chats, plus their snapshot and history pages. */
const registerGroupChatDefinitionRoutes = (options: GroupChatRoutesOptions) => {
  const { register } = options;
  const groupChats = () => requireGroupChats(options.groupChats);

  register(routes.listGroupChats, (c) => c.json(groupChats().list(), 200));
  register(routes.createGroupChat, async (c) =>
    c.json(groupChats().create(groupChatInput.parse(await c.req.json())), 201),
  );
  register(routes.getGroupChat, (c) =>
    c.json(groupChats().get(c.req.param("id")), 200),
  );
  register(routes.updateGroupChat, async (c) => {
    const current = groupChats().get(c.req.param("id"));

    // Merge before validation, as agent updates do.
    const input = groupChatInput.parse({
      name: current.name,
      memberIds: current.memberIds,
      ...(await c.req.json()),
    });

    return c.json(await groupChats().update(current.id, input), 200);
  });
  register(routes.deleteGroupChat, async (c) => {
    await groupChats().delete(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatSnapshot, async (c) =>
    c.json(
      await groupChats().snapshot(
        c.req.param("id"),
        snapshotInput.parse(c.req.query()),
      ),
      200,
    ),
  );
  register(routes.groupChatHistory, async (c) =>
    c.json(
      await groupChats().history(
        c.req.param("id"),
        historyInput.parse(c.req.query()),
      ),
      200,
    ),
  );
};

/** The group chat's messages, an attachment they refer to, and its events. */
const registerGroupMessageRoutes = (options: GroupChatRoutesOptions) => {
  const { register } = options;
  const groupChats = () => requireGroupChats(options.groupChats);

  register(routes.sendGroupMessage, async (c) => {
    const input = groupMessageInput.parse(await c.req.json());

    return c.json(
      await groupChats().post(
        c.req.param("id"),
        input.content,
        input.requestId,
        { replyTo: input.replyTo, attachments: input.attachments },
      ),
      201,
    );
  });
  register(routes.groupAttachment, async (c) => {
    const index = attachmentIndex.parse(c.req.param("index"));

    const file = await groupChats().attachment(
      c.req.param("id"),
      c.req.param("entryId"),
      index,
    );

    return c.body(new Uint8Array(file.data), 200, {
      "Content-Type": file.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
  register(routes.stopGroupChat, async (c) => {
    await groupChats().stop(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatEvents, async (c) => {
    const query = snapshotInput.parse(c.req.query());
    const groups = groupChats();
    const groupId = groups.get(c.req.param("id")).id;

    return streamEvents(c, async ({ stream, close, onClose }) => {
      const sendSnapshot = snapshotSender(stream, () =>
        groups.snapshot(groupId, query),
      );

      // A deleted group fails its next snapshot, which ends the stream.
      onClose(
        groups.subscribe(groupId, () => {
          void sendSnapshot().catch(close);
        }),
      );

      await sendSnapshot();
    });
  });
};

/** The group chat routes, in the order the contract document lists them. */
export function registerGroupChatRoutes(options: GroupChatRoutesOptions) {
  registerGroupChatDefinitionRoutes(options);
  registerGroupMessageRoutes(options);
}
