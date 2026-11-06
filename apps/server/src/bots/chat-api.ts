import type { z } from "zod";
import { routes } from "../contract/api-contract";
import type {
  chatSnapshotResponse,
  codingJobsResponse,
  desktopJobsResponse,
} from "../contract/api-responses";
import type { Register } from "../contract/route";
import { attachmentHeaders } from "../shared/attachments";
import { snapshotSender, streamEvents } from "../shared/event-stream";
import type { BotsAccess } from "./bots";

type ChatRoutesOptions = {
  register: Register;
  service: BotsAccess;
};

const registerChatReadRoutes = (options: ChatRoutesOptions) => {
  const { register, service } = options;

  register(routes.chat, async (c) => {
    const snapshot: z.output<typeof chatSnapshotResponse> =
      await service.chatSnapshot(c.req.param("id"), c.req.valid("query"));

    return c.json(snapshot, 200);
  });
  register(routes.history, async (c) =>
    c.json(await service.history(c.req.param("id"), c.req.valid("query")), 200),
  );
  register(routes.codingJobs, async (c) => {
    const jobs: z.output<typeof codingJobsResponse> = {
      jobs: await service.jobs(c.req.param("id"), "coding"),
    };

    return c.json(jobs, 200);
  });
  register(routes.answerCodingJob, async (c) => {
    await service.answerJob(c.req.param("id"), "coding", {
      name: c.req.param("name"),
      ...c.req.valid("json"),
    });

    return c.body(null, 204);
  });
  register(routes.codingJobHistory, async (c) =>
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
  register(routes.desktopJobs, async (c) => {
    const jobs: z.output<typeof desktopJobsResponse> = {
      jobs: await service.jobs(c.req.param("id"), "desktop"),
    };

    return c.json(jobs, 200);
  });
  register(routes.desktopJobHistory, async (c) =>
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

  register(routes.sendMessage, async (c) => {
    const input = c.req.valid("json");

    return c.json(
      await service.sendChat(
        c.req.param("id"),
        input.content,
        input.requestId,
        input.replyTo,
        input.attachments,
        input.timezone,
      ),
      202,
    );
  });
  register(routes.attachment, async (c) => {
    const { id, entryId, index } = c.req.valid("param");
    const image = await service.attachment(id, entryId, index);

    return c.body(
      new Uint8Array(image.data),
      200,
      attachmentHeaders(image.mimeType),
    );
  });
  register(routes.abort, async (c) => {
    await service.abortChat(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.compact, async (c) =>
    c.json({ taskId: await service.compact(c.req.param("id")) }, 202),
  );
};

const registerChatEventRoutes = (options: ChatRoutesOptions) => {
  const { register, service } = options;

  register(routes.chatEvents, async (c) => {
    const snapshot = c.req.valid("query");
    const agent = service.agent(c.req.param("id"));
    const chat = await service.chat(agent.id);

    return streamEvents(c, async ({ stream, close, onClose }) => {
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
  });
};

export function registerChatRoutes(options: ChatRoutesOptions) {
  registerChatReadRoutes(options);
  registerChatMessageRoutes(options);
  registerChatEventRoutes(options);
}
