// Ported from Hermes' claude-subscription-directsdk admission.py (MIT, see THIRD_PARTY_NOTICES.md).
import { randomInt } from "node:crypto";
import { z } from "zod";
import { ANTHROPIC_ORIGIN, isOff } from "./native";

const GZIP_HOSTS = new Set([new URL(ANTHROPIC_ORIGIN).hostname]);

const GZIP_CA_ENV = [
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
];

const PROXY_ENV = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"];

// Claude Code 2.1.302's origin-400 test.
const GO_BAD_JSON =
  /^bad json: (?:invalid character |unexpected EOF$|unexpected end of JSON input$|EOF$)/;

export class GzipFallback {
  reason: string | undefined;

  disable(reason: string) {
    this.reason ??= reason;
  }
}

/** The fallback every model request of this process shares: a refusal holds for all of them. */
export const PROCESS_GZIP = new GzipFallback();

const goError = z.object({ reason: z.literal("bad_json"), error: z.string() });

const anthropicError = z.object({
  type: z.string().optional(),
  error: z.looseObject({
    type: z.string().optional(),
    message: z.string().optional(),
    details: z.looseObject({ error_code: z.string().optional() }).optional(),
  }),
});

const INVALID_JSON_MESSAGES = [
  "The request body is not valid JSON",
  "Failed to parse request: could not parse request body as JSON",
];

// The message prefix counts only in a full Anthropic error envelope.
const invalidJsonEnvelope = ({ type, error }: z.infer<typeof anthropicError>) =>
  type === "error" &&
  error.type !== undefined &&
  INVALID_JSON_MESSAGES.some((prefix) => error.message?.startsWith(prefix));

const jsonValue = z.json();

type JsonValue = z.infer<typeof jsonValue>;

function originBadJson(raw: JsonValue) {
  const go = goError.safeParse(raw);

  if (go.success) return GO_BAD_JSON.test(go.data.error);
  const parsed = anthropicError.safeParse(raw);

  return parsed.success && invalidJsonEnvelope(parsed.data);
}

const encodingUnsupported = (raw: JsonValue) => {
  const parsed = anthropicError.safeParse(raw);

  return (
    parsed.success &&
    (parsed.data.error.details?.error_code ===
      "request_body_encoding_unsupported" ||
      parsed.data.error.message?.startsWith("Unsupported Content-Encoding") ===
        true)
  );
};

const fromAnthropic = (headers: Headers) =>
  (headers.get("request-id") ?? "").startsWith("req_") ||
  Boolean(headers.get("cf-ray"));

function headerRejection(status: number, headers: Headers) {
  if (!fromAnthropic(headers)) return "non_anthropic_rejection";

  return status === 415 ? "unsupported_encoding" : undefined;
}

const badJsonText = (text: string) =>
  GO_BAD_JSON.test(text.trimEnd()) ? "invalid_json_at_origin" : undefined;

function originRejection(raw: JsonValue) {
  if (!goError.safeParse(raw).success && encodingUnsupported(raw))
    return "unsupported_encoding";

  return originBadJson(raw) ? "invalid_json_at_origin" : undefined;
}

function bodyRejection(text: string) {
  let raw: JsonValue;

  try {
    raw = jsonValue.parse(JSON.parse(text));
  } catch {
    return badJsonText(text);
  }

  return originRejection(raw);
}

export function rejectionKind(status: number, headers: Headers, text: string) {
  if (![400, 403, 415].includes(status)) return;

  return (
    headerRejection(status, headers) ??
    (status === 400 ? bodyRejection(text) : undefined)
  );
}

export function gzipPayload(payload: string) {
  const padding = Array.from({ length: randomInt(257) }, () =>
    randomInt(2) ? " " : "\t",
  ).join("");

  return Bun.gzipSync(Buffer.from(`${payload}\n${padding}`), { level: 3 });
}

function gzipAllowedByEnv(env: Record<string, string | undefined>) {
  return (
    !PROXY_ENV.some((name) => env[name]) &&
    !GZIP_CA_ENV.some((name) => name in env) &&
    !isOff(env["CLAUDE_CODE_GZIP_REQUEST_BODIES"] ?? "")
  );
}

export const gzipEligible = (
  upstream: URL,
  env: Record<string, string | undefined>,
  fallback: GzipFallback,
) =>
  GZIP_HOSTS.has(upstream.hostname) &&
  upstream.port === "" &&
  gzipAllowedByEnv(env) &&
  fallback.reason === undefined;
