import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { MessageGateway } from "./message-gateway";

export function registerGatewayRoutes(options: {
  register: Register<Env, MessageGateway>;
}) {
  const { register } = options;

  register(routes.messageGateways, function* (c) {
    const gateway = yield* MessageGateway;

    return c.json({ gateways: yield* gateway.list }, 200);
  });
  register(routes.updateMessageGateway, function* (c) {
    const gateway = yield* MessageGateway;

    return c.json(
      yield* gateway.update(c.req.param("id"), c.req.valid("json")),
      200,
    );
  });
}
