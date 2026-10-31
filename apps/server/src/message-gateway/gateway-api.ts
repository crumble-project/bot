import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { NotFound } from "../shared/errors";
import { gatewayConfigInput } from "../contract/message-gateway";
import { MessageGateway } from "./message-gateway";

export function registerGatewayRoutes(options: {
  register: Register;
  messageGateway?: MessageGateway["Service"] | undefined;
}) {
  const { register, messageGateway } = options;
  register(routes.messageGateways, async (c) =>
    c.json(
      {
        gateways: messageGateway
          ? await Effect.runPromise(messageGateway.list)
          : [],
      },
      200,
    ),
  );
  register(routes.updateMessageGateway, async (c) => {
    if (!messageGateway)
      throw new NotFound({ message: "Message gateway not installed" });

    return c.json(
      await Effect.runPromise(
        messageGateway.update(
          c.req.param("id"),
          gatewayConfigInput.parse(await c.req.json()),
        ),
      ),
      200,
    );
  });
}
