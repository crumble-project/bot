import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { CallRequests } from "./call-requests";

type Options = {
  register: Register<Env, CallRequests>;
  service: BotLookup;
};

export function registerCallRequestRoutes(options: Options) {
  const { register, service } = options;

  // Looks the bot up first, so an unknown bot answers 404.
  const agentOf = (id: string) => service.agent(id).id;

  register(routes.listCallRequests, function* (c) {
    const callRequests = yield* CallRequests;

    return c.json(yield* callRequests.list(agentOf(c.req.param("id"))), 200);
  });
  register(routes.approveCallRequest, function* (c) {
    const callRequests = yield* CallRequests;

    return c.json(
      yield* callRequests.approve(
        agentOf(c.req.param("id")),
        c.req.param("requestId"),
      ),
      200,
    );
  });
  register(routes.declineCallRequest, function* (c) {
    const callRequests = yield* CallRequests;

    return c.json(
      yield* callRequests.decline(
        agentOf(c.req.param("id")),
        c.req.param("requestId"),
      ),
      200,
    );
  });
  register(routes.callRequestTranscript, function* (c) {
    const callRequests = yield* CallRequests;

    const page = yield* callRequests.transcript(
      agentOf(c.req.param("id")),
      c.req.param("requestId"),
      c.req.valid("query"),
    );

    return c.json(
      {
        ...page,
        messages: page.messages.map((message) => ({
          ...message,
          replyReferences: [],
        })),
      },
      200,
    );
  });
}
