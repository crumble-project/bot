import { z } from "zod";
import { CONNECTION_STATUSES } from "../shared/domain";

export const normalizeGatewayHandle = (handle: string) =>
  handle.normalize("NFKC").toLowerCase();

export const MAX_GATEWAY_ID_CHARS = 200;
export const MAX_GATEWAY_ALIAS_CHARS = 100;

export const gatewayConfigInput = z
  .object({
    enabled: z.boolean(),
    defaultBotId: z.uuid().nullable(),
    ownerId: z
      .string()
      .trim()
      .min(1)
      .max(MAX_GATEWAY_ID_CHARS)
      .regex(/^[^\s,]+$/u)
      .nullable(),
    allowedChannelIds: z
      .array(z.string().trim().min(1).max(MAX_GATEWAY_ID_CHARS))
      .max(1000),
    allowDirectMessages: z.boolean(),
    aliases: z
      .array(
        z.object({
          handle: z
            .string()
            .trim()
            .min(1)
            .max(MAX_GATEWAY_ALIAS_CHARS)
            .regex(/^[\p{L}\p{N}_-]+$/u),
          botId: z.uuid(),
        }),
      )
      .max(1000),
  })
  .strict()
  .refine(
    (input) =>
      new Set(
        input.aliases.map((alias) => normalizeGatewayHandle(alias.handle)),
      ).size === input.aliases.length,
    {
      message: "Alias handles must be unique (ignoring case)",
      path: ["aliases"],
    },
  );

export const gatewayResponse = z.object({
  id: z.string(),
  label: z.string(),
  secretKey: z.string(),
  tokenConfigured: z.boolean(),
  config: gatewayConfigInput,
  status: z.enum(CONNECTION_STATUSES),
  error: z.string().nullable(),
  pendingCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});

export const gatewaysResponse = z.object({
  gateways: z.array(gatewayResponse),
});

export type GatewayConfig = z.infer<typeof gatewayConfigInput>;

export type GatewayDescription = z.infer<typeof gatewayResponse>;

export const defaultGatewayConfig = (): GatewayConfig => ({
  enabled: false,
  defaultBotId: null,
  ownerId: null,
  allowedChannelIds: [],
  allowDirectMessages: false,
  aliases: [],
});
