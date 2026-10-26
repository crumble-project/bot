import type { z } from "zod";
import {
  routes,
  attachmentIndex,
  historyInput,
  messageInput,
  snapshotInput,
} from "../contract/api-contract";
import type {
  chatSnapshotResponse,
  codingJobsResponse,
  desktopJobsResponse,
} from "../contract/api-responses";
import type { Register } from "../contract/route";
import { snapshotSender, streamEvents } from "../app/event-stream";
import type { AgentRuntime } from "./runtime";
import type { BotsAccess } from "./bots";

type ChatRoutesOptions = {
  register: Register;
  service: BotsAccess;
  runtime: AgentRuntime;
};

/** The bot chat's transcript pages, its coding and desktop jobs, and one job's history. */
const registerChatReadRoutes = (options: ChatRoutesOptions) => {
  const { register, service } = options;

  register(routes.chat, async (c) => {
    const snapshot: z.output<typeof chatSnapshotResponse> =
      await service.chatSnapshot(
        c.req.param("id"),
        snapshotInput.parse(c.req.query()),
      );

    return c.json(snapshot, 200);
  });
  register(routes.history, async (c) => {
    const input = historyInput.parse(c.req.query());

    return c.json(await service.history(c.req.param("id"), input), 200);
  });
  register(routes.codingJobs, async (c) => {
    const jobs: z.output<typeof codingJobsResponse> = {
      jobs: await service.codingJobs(c.req.param("id")),
    };

    return c.json(jobs, 200);
  });
  register(routes.codingJobHistory, async (c) =>
    c.json(
      await service.codingJobHistory(
        c.req.param("id"),
        c.req.param("name"),
        historyInput.parse(c.req.query()),
      ),
      200,
    ),
  );
  register(routes.desktopJobs, async (c) => {
    const jobs: z.output<typeof desktopJobsResponse> = {
      jobs: await service.desktopJobs(c.req.param("id")),
    };

    return c.json(jobs, 200);
  });
  register(routes.desktopJobHistory, async (c) =>
    c.json(
      await service.desktopJobHistory(
        c.req.param("id"),
        c.req.param("name"),
        historyInput.parse(c.req.query()),
      ),
      200,
    ),
  );
};

/** Sending a message, reading an attachment a reply refers to, and stopping or compacting a bot's turn. */
const registerChatMessageRoutes = (options: ChatRoutesOptions) => {
  const { register, service, runtime } = options;

  register(routes.sendMessage, async (c) => {
    const input = messageInput.parse(await c.req.json());

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
    const index = attachmentIndex.parse(c.req.param("index"));

    const image = await runtime.attachment(
      service.agent(c.req.param("id")),
      c.req.param("entryId"),
      index,
    );

    return c.body(new Uint8Array(image.data), 200, {
      "Content-Type": image.mimeType,
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
  register(routes.abort, async (c) => {
    await service.abortChat(c.req.param("id"));

    return c.body(null, 204);
  });
  register(routes.compact, async (c) =>
    c.json({ taskId: await service.compact(c.req.param("id")) }, 202),
  );
};

/** One bot chat's events, from a snapshot and then as each entry settles. */
const registerChatEventRoutes = (options: ChatRoutesOptions) => {
  const { register, service, runtime } = options;

  register(routes.chatEvents, async (c) => {
    const snapshot = snapshotInput.parse(c.req.query());
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
      onClose(await runtime.watch(agent, chat.id, sendSnapshot, snapshot));
    });
  });
};

/** The bot chat routes, in the order the contract document lists them. */
export function registerChatRoutes(options: ChatRoutesOptions) {
  registerChatReadRoutes(options);
  registerChatMessageRoutes(options);
  registerChatEventRoutes(options);
}
