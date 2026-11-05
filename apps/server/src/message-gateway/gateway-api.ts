import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { Runner } from "../shared/runner";
import { MessageGateway } from "./message-gateway";

export function registerGatewayRoutes(options: {
  register: Register;
  run: Runner<MessageGateway>;
}) {
  const { register, run } = options;

  register(routes.messageGateways, async (c) =>
    c.json(
      { gateways: await run.runPromise(MessageGateway.use((s) => s.list)) },
      200,
    ),
  );
  register(routes.updateMessageGateway, async (c) =>
    c.json(
      await run.runPromise(
        MessageGateway.use((s) =>
          s.update(c.req.param("id"), c.req.valid("json")),
        ),
      ),
      200,
    ),
  );
}
