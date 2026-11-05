import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { MessageGateway } from "./message-gateway";

export function registerGatewayRoutes(options: {
  register: Register;
  messageGateway: MessageGateway["Service"];
}) {
  const { register, messageGateway } = options;

  register(routes.messageGateways, async (c) =>
    c.json({ gateways: await Effect.runPromise(messageGateway.list) }, 200),
  );
  register(routes.updateMessageGateway, async (c) =>
    c.json(
      await Effect.runPromise(
        messageGateway.update(c.req.param("id"), c.req.valid("json")),
      ),
      200,
    ),
  );
}
