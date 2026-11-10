import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { Runner } from "../shared/runner";
import type { CallRequests } from "./call-requests";

type Options = {
  register: Register;
  service: BotLookup;
  callRequests: CallRequests["Service"];
  run: Runner<never>;
};

export function registerCallRequestRoutes(options: Options) {
  const { register, service, callRequests, run } = options;

  // Looks the bot up first, so an unknown bot answers 404.
  const agentOf = (id: string) => service.agent(id).id;

  register(routes.listCallRequests, async (c) =>
    c.json(
      await run.runPromise(callRequests.list(agentOf(c.req.param("id")))),
      200,
    ),
  );
  register(routes.approveCallRequest, async (c) =>
    c.json(
      await run.runPromise(
        callRequests.approve(
          agentOf(c.req.param("id")),
          c.req.param("requestId"),
        ),
      ),
      200,
    ),
  );
  register(routes.declineCallRequest, async (c) =>
    c.json(
      await run.runPromise(
        callRequests.decline(
          agentOf(c.req.param("id")),
          c.req.param("requestId"),
        ),
      ),
      200,
    ),
  );
  register(routes.callRequestTranscript, async (c) =>
    c.json(
      await run.runPromise(
        callRequests.transcript(
          agentOf(c.req.param("id")),
          c.req.param("requestId"),
          c.req.valid("query"),
        ),
      ),
      200,
    ),
  );
}
