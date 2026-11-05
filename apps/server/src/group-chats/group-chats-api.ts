import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { snapshotSender, streamEvents } from "../shared/event-stream";
import { groupChatInput } from "../shared/domain";
import type { GroupChatsAccess } from "./group-chats";

type GroupChatRoutesOptions = {
  register: Register;
  groupChats: GroupChatsAccess;
};

/** Listing, creating, editing, and deleting group chats, plus their snapshot and history pages. */
const registerGroupChatDefinitionRoutes = (options: GroupChatRoutesOptions) => {
  const { register, groupChats } = options;

  register(routes.listGroupChats, (c) => c.json(groupChats.list(), 200));
  register(routes.createGroupChat, (c) =>
    c.json(groupChats.create(c.req.valid("json")), 201),
  );
  register(routes.getGroupChat, (c) =>
    c.json(groupChats.get(c.req.param("id")), 200),
  );
  register(
    routes.updateGroupChat,
    async (c) => {
      const current = groupChats.get(c.req.param("id"));

      const input = groupChatInput.parse({
        name: current.name,
        memberIds: current.memberIds,
        ...(await c.req.json()),
      });

      return c.json(await groupChats.update(current.id, input), 200);
    },
    { parsesBody: true },
  );
  register(routes.deleteGroupChat, async (c) => {
    await groupChats.delete(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatSnapshot, async (c) =>
    c.json(
      await groupChats.snapshot(c.req.param("id"), c.req.valid("query")),
      200,
    ),
  );
  register(routes.groupChatHistory, async (c) =>
    c.json(
      await groupChats.history(c.req.param("id"), c.req.valid("query")),
      200,
    ),
  );
};

/** The group chat's messages, an attachment they refer to, and its events. */
const registerGroupMessageRoutes = (options: GroupChatRoutesOptions) => {
  const { register, groupChats } = options;

  register(routes.sendGroupMessage, async (c) => {
    const input = c.req.valid("json");

    return c.json(
      await groupChats.post(c.req.param("id"), input.content, input.requestId, {
        replyTo: input.replyTo,
        attachments: input.attachments,
      }),
      201,
    );
  });
  register(routes.groupAttachment, async (c) => {
    const { id, entryId, index } = c.req.valid("param");
    const file = await groupChats.attachment(id, entryId, index);

    return c.body(new Uint8Array(file.data), 200, {
      "Content-Type": file.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
  register(routes.stopGroupChat, async (c) => {
    await groupChats.stop(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.groupChatEvents, async (c) => {
    const query = c.req.valid("query");
    const groupId = groupChats.get(c.req.param("id")).id;

    return streamEvents(c, async ({ stream, close, onClose }) => {
      const sendSnapshot = snapshotSender(stream, () =>
        groupChats.snapshot(groupId, query),
      );

      // A deleted group fails its next snapshot, which ends the stream.
      onClose(
        groupChats.subscribe(groupId, () => {
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
