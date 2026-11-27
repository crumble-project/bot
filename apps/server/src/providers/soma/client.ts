import { z } from "zod";

export const SOMA_PROTOCOL = "1";
export const SOMA_PROTOCOL_HEADER = "Soma-Protocol";
export const SOMA_URL_ENV = "SOMA_URL";
export const SOMA_TOKEN_ENV = "SOMA_TOKEN";

const ABORT_TIMEOUT_MS = 5000;
const INFO_TIMEOUT_MS = 10_000;

export const somaModelInfoSchema = z.object({
  id: z.string(),
  contextWindow: z.number().optional(),
  maxOutput: z.number().optional(),
  thinking: z.array(z.string()).nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  effort: z.record(z.string(), z.string()).nullable().optional(),
  thinkingFormat: z.string().optional(),
  input: z.array(z.string()).nullable().optional(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
  cachedPrice: z.number().optional(),
});

export type SomaModelInfo = z.output<typeof somaModelInfoSchema>;

export const somaUpstreamsSchema = z.object({
  upstreams: z.array(z.string()),
});

export const somaInfoSchema = z.object({
  holdsConversation: z.boolean(),
  models: z.array(somaModelInfoSchema),
});

export type SomaInfo = z.output<typeof somaInfoSchema>;

export const somaUsageSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  reasoning: z.number(),
  cost: z.number(),
});

export type SomaUsage = z.output<typeof somaUsageSchema>;

export const somaBlockSchema = z.object({
  type: z.enum(["text", "thinking", "tool_call", "image"]),
  text: z.string().optional(),
  callId: z.string().optional(),
  name: z.string().optional(),
  args: z.json().optional(),
  mime: z.string().optional(),
  blob: z.string().optional(),
  opaque: z.json().optional(),
});

export type SomaBlock = z.output<typeof somaBlockSchema>;

export const somaMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]).or(z.literal("")),
  blocks: z.array(somaBlockSchema).nullable().optional(),
  callId: z.string().optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  provider: z.string().optional(),
  api: z.string().optional(),
  model: z.string().optional(),
  thinking: z.string().optional(),
  usage: somaUsageSchema.nullable().optional(),
  stopReason: z.string().optional(),
});

export type SomaMessage = z.output<typeof somaMessageSchema>;

export const somaErrorSchema = z.object({
  provider: z.boolean(),
  kind: z.string(),
  status: z.number(),
  retryAfterMs: z.number(),
  message: z.string(),
});

export type SomaWireError = z.output<typeof somaErrorSchema>;

export const somaLineSchema = z.object({
  stream: z.string().optional(),
  delta: z
    .object({
      kind: z.string(),
      text: z.string(),
    })
    .nullable()
    .optional(),
  keepAlive: z.boolean().optional(),
  done: z.boolean().optional(),
  message: somaMessageSchema.nullable().optional(),
  error: somaErrorSchema.nullable().optional(),
});

export type SomaLine = z.output<typeof somaLineSchema>;

export const somaMissingBlobsSchema = z.object({
  missing: z.array(z.string()),
});

export type SomaConnection = {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
};

export function normalizeSomaUrl(raw: string): string | undefined {
  const trimmed = raw.trim();

  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }

  return parsed.toString().replace(/\/+$/, "");
}

export function redactToken(message: string, token: string): string {
  return token ? message.replaceAll(token, "[redacted]") : message;
}

export function checkSomaProtocol(response: Response): void {
  const version = response.headers.get(SOMA_PROTOCOL_HEADER);

  if (version === SOMA_PROTOCOL) {
    return;
  }

  throw new Error(
    `Soma server protocol "${version ?? ""}" is incompatible with protocol ${SOMA_PROTOCOL}`,
  );
}

export async function readSomaError(
  response: Response,
  token: string,
): Promise<string> {
  const text = await response.text().catch(() => "");

  if (text) {
    try {
      const parsed = somaErrorSchema.safeParse(JSON.parse(text));

      if (parsed.success && parsed.data.message) {
        return redactToken(parsed.data.message, token);
      }
    } catch {
      return redactToken(
        `Soma request failed (${response.status}): ${text.slice(0, 200)}`,
        token,
      );
    }
  }

  return `Soma request failed with HTTP ${response.status}`;
}

export async function somaRequest(
  connection: SomaConnection,
  method: string,
  path: string,
  options?: {
    body?: BodyInit;
    contentType?: string;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const headers = {
    Authorization: `Bearer ${connection.token}`,
    [SOMA_PROTOCOL_HEADER]: SOMA_PROTOCOL,
    ...(options?.contentType && { "Content-Type": options.contentType }),
  };

  const doFetch = connection.fetch ?? globalThis.fetch;

  return doFetch(`${connection.baseUrl}${path}`, {
    method,
    headers,
    ...(options?.body !== undefined && { body: options.body }),
    redirect: "manual",
    ...(options?.signal !== undefined && { signal: options.signal }),
  });
}

function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const timer = AbortSignal.timeout(ms);

  return parent ? AbortSignal.any([parent, timer]) : timer;
}

export async function fetchSomaUpstreams(
  connection: SomaConnection,
  signal?: AbortSignal,
): Promise<Array<string>> {
  const response = await somaRequest(connection, "GET", "/v1/upstreams", {
    signal: timeoutSignal(INFO_TIMEOUT_MS, signal),
  });

  checkSomaProtocol(response);

  if (!response.ok) {
    throw new Error(await readSomaError(response, connection.token));
  }

  const parsed = somaUpstreamsSchema.parse(await response.json());

  return parsed.upstreams;
}

export async function fetchSomaInfo(
  connection: SomaConnection,
  upstream: string,
  signal?: AbortSignal,
): Promise<SomaInfo> {
  const response = await somaRequest(
    connection,
    "GET",
    `/v1/info?upstream=${encodeURIComponent(upstream)}`,
    { signal: timeoutSignal(INFO_TIMEOUT_MS, signal) },
  );

  checkSomaProtocol(response);

  if (!response.ok) {
    throw new Error(await readSomaError(response, connection.token));
  }

  return somaInfoSchema.parse(await response.json());
}

export async function uploadSomaBlob(
  connection: SomaConnection,
  sha256: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<void> {
  const response = await somaRequest(connection, "PUT", `/v1/blobs/${sha256}`, {
    body: bytes,
    ...(signal !== undefined && { signal }),
  });

  checkSomaProtocol(response);

  if (response.status !== 204 && !response.ok) {
    throw new Error(await readSomaError(response, connection.token));
  }
}

export async function abortSomaStream(
  connection: SomaConnection,
  streamId: string,
): Promise<void> {
  try {
    const response = await somaRequest(connection, "POST", "/v1/abort", {
      body: JSON.stringify({ stream: streamId }),
      contentType: "application/json",
      signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
    });

    await response.body?.cancel();
  } catch {
    return;
  }
}

export async function endSomaRun(
  connection: SomaConnection,
  upstream: string,
  sessionId: string,
): Promise<void> {
  try {
    const response = await somaRequest(connection, "POST", "/v1/endrun", {
      body: JSON.stringify({ upstream, sessionId }),
      contentType: "application/json",
      signal: AbortSignal.timeout(ABORT_TIMEOUT_MS),
    });

    await response.body?.cancel();
  } catch {
    return;
  }
}
