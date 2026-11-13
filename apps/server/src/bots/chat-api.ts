import type { Context } from "hono";
import type { z } from "zod";
import { routes } from "../contract/api-contract";
import type {
  chatSnapshotResponse,
  codingJobsResponse,
  desktopJobsResponse,
} from "../contract/api-responses";
import type { Register } from "../contract/route";
import { attachmentHeaders } from "../shared/attachments";
import {
  snapshotSender,
  streamEvents,
  type StreamCleanup,
} from "../shared/event-stream";
import type { BotsAccess } from "./bots";
import type { SnapshotOptions } from "./runtime";

type ChatRoutesOptions = {
  register: Register;
  service: BotsAccess;
};

const registerChatReadRoutes = (options: ChatRoutesOptions) => {
  const { register, service } = options;

  register.plain(routes.chat, async (c) => {
    const snapshot: z.output<typeof chatSnapshotResponse> =
      await service.chatSnapshot(c.req.param("id"), c.req.valid("query"));

    return c.json(snapshot, 200);
  });
  register.plain(routes.history, async (c) =>
    c.json(await service.history(c.req.param("id"), c.req.valid("query")), 200),
  );
  register.plain(routes.codingJobs, async (c) => {
    const jobs: z.output<typeof codingJobsResponse> = {
      jobs: await service.jobs(c.req.param("id"), "coding"),
    };

    return c.json(jobs, 200);
  });
  register.plain(routes.answerCodingJob, async (c) => {
    await service.answerJob(c.req.param("id"), "coding", {
      name: c.req.param("name"),
      ...c.req.valid("json"),
    });

    return c.body(null, 204);
  });
  register.plain(routes.codingJobHistory, async (c) =>
    c.json(
      await service.jobHistory(
        c.req.param("id"),
        "coding",
        c.req.param("name"),
        c.req.valid("query"),
      ),
      200,
    ),
  );
  register.plain(routes.desktopJobs, async (c) => {
    const jobs: z.output<typeof desktopJobsResponse> = {
      jobs: await service.jobs(c.req.param("id"), "desktop"),
    };

    return c.json(jobs, 200);
  });
  register.plain(routes.desktopJobHistory, async (c) =>
    c.json(
      await service.jobHistory(
        c.req.param("id"),
        "desktop",
        c.req.param("name"),
        c.req.valid("query"),
      ),
      200,
    ),
  );
};

const registerChatMessageRoutes = (options: ChatRoutesOptions) => {
  const { register, service } = options;

  register.plain(routes.sendMessage, async (c) => {
    const input = c.req.valid("json");

    return c.json(
      await service.sendChat(
        c.req.param("id"),
        input.content,
        input.requestId,
        input.replyTo,
        input.files,
        input.timezone,
      ),
      202,
    );
  });
  register.plain(routes.attachment, async (c) => {
    const { id, entryId, index } = c.req.valid("param");
    const image = await service.attachment(id, entryId, index);

    return c.body(
      new Uint8Array(image.data),
      200,
      attachmentHeaders(image.mimeType),
    );
  });
  register.plain(routes.abort, async (c) => {
    await service.abortChat(c.req.param("id"));

    return c.body(null, 204);
  });
  register.plain(routes.compact, async (c) =>
    c.json({ taskId: await service.compact(c.req.param("id")) }, 202),
  );
};

/**
 * A bot chat's snapshot stream, or another of the bot's conversations' with `conversationId`. `opened` can refuse the
 * stream before it sends anything, by returning null.
 */
export const chatEventStream = async (
  c: Context,
  service: BotsAccess,
  options: {
    agentId: string;
    conversationId?: string | undefined;
    snapshot: SnapshotOptions;
    opened?: (close: () => void) => Promise<StreamCleanup | null>;
  },
) => {
  const { snapshot, opened } = options;
  const agent = service.agent(options.agentId);

  const chat = options.conversationId
    ? { id: options.conversationId }
    : await service.chat(agent.id);

  return streamEvents(c, async ({ stream, close, onClose }) => {
    if (opened) {
      const cleanup = await opened(close);

      if (!cleanup) return close();
      onClose(cleanup);
    }

    const sendSnapshot = snapshotSender(stream, () =>
      service.snapshot(chat.id, snapshot),
    );

    onClose(
      service.subscribe(chat.id, () => {
        void sendSnapshot().catch(close);
      }),
    );
    onClose(await service.watch(agent.id, chat.id, sendSnapshot, snapshot));
  });
};

const registerChatEventRoutes = (options: ChatRoutesOptions) => {
  const { register, service } = options;

  register.plain(routes.chatEvents, (c) =>
    chatEventStream(c, service, {
      agentId: c.req.param("id"),
      snapshot: c.req.valid("query"),
    }),
  );
};

export function registerChatRoutes(options: ChatRoutesOptions) {
  registerChatReadRoutes(options);
  registerChatMessageRoutes(options);
  registerChatEventRoutes(options);
}
