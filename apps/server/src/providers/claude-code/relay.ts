// Ported from Hermes' claude-subscription-directsdk admission.py (MIT, see THIRD_PARTY_NOTICES.md).
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Capture } from "./relay-capture";
import {
  gzipEligible,
  gzipPayload,
  rejectionKind,
  type GzipFallback,
} from "./relay-gzip";
import {
  QueriedTurnMismatch,
  dropMessageBreakpoints,
  pinMessageBreakpoint,
  restoreQueriedTurn,
  stableRequestContext,
  streamToolInput,
  type Block,
} from "./relay-request";

/** Request-scoped native HTTP admission: forwards Claude Code's first Messages request, refuses the rest. */

// Native's own byte-level watchdog against api.anthropic.com (180 s); behind the relay it widens to 300 s.
const UPSTREAM_IDLE_MS = 180_000;

const DENIAL = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "CRUMBLE_MODEL_ADMISSION_CONSUMED",
  },
});

const FORWARDED_REQUEST_HEADERS_EXCLUDED = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
]);

// Bun's fetch has already decoded the body and frames it itself.
const FORWARDED_RESPONSE_HEADERS_EXCLUDED = new Set([
  "connection",
  "transfer-encoding",
  "server",
  "date",
  "content-length",
  "content-encoding",
]);

function forwardedRequestHeaders(request: Request) {
  const headers = new Headers();

  for (const [key, value] of request.headers)
    if (!FORWARDED_REQUEST_HEADERS_EXCLUDED.has(key)) headers.set(key, value);
  headers.set("accept-encoding", "identity");

  return headers;
}

function forwardedResponseHeaders(response: Response) {
  const forwarded = new Headers();

  for (const [key, value] of response.headers)
    if (!FORWARDED_RESPONSE_HEADERS_EXCLUDED.has(key))
      forwarded.set(key, value);
  forwarded.set("connection", "close");

  return forwarded;
}

export type AdmissionOptions = {
  /** The turn being asked, whose blocks the relay restores in the request. */
  queried?: readonly Block[] | undefined;
  /** A tool-less one-shot that nothing replays: its message marks are dropped instead of moved. */
  oneShot?: boolean;
  /** The environment the child runs in, whose proxy and certificate settings forbid compression. */
  env: Record<string, string | undefined>;
  gzip: GzipFallback;
};

class UpstreamIdle extends Error {
  constructor(seconds: number) {
    super(`no upstream bytes for ${seconds} s`);
    this.name = "UpstreamIdle";
  }
}

/**
 * One loopback listener per model request on a random port and route. Claude Code is pointed at it through
 * `ANTHROPIC_BASE_URL`; its authorization headers pass through memory to the upstream and are never logged or kept.
 */
export class Admission {
  readonly url: string;
  used = false;
  denied = 0;
  status: number | undefined;
  failure: string | undefined;
  readonly capture = new Capture();
  private errorBody = "";
  private cancelled = false;
  private readonly upstream: URL;
  private readonly prefix = `/admit/${randomBytes(32).toString("base64url")}`;
  private readonly controller = new AbortController();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(
    upstream: string,
    private readonly timeoutMs: number,
    private readonly options: AdmissionOptions,
  ) {
    this.upstream = new URL(upstream);
    const host = this.upstream.hostname;
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(host);

    if (
      (this.upstream.protocol !== "https:" &&
        !(this.upstream.protocol === "http:" && local)) ||
      !host ||
      this.upstream.username ||
      this.upstream.password ||
      this.upstream.search ||
      this.upstream.hash
    )
      throw new Error(
        "Native upstream must be HTTPS or a loopback HTTP fixture",
      );
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A healthy upstream can think for minutes before its next byte; the upstream idle limit bounds it instead.
      idleTimeout: 0,
      fetch: (request) => this.handle(request),
    });
    this.url = `http://127.0.0.1:${this.server.port}${this.prefix}`;
  }

  /** The upstream's own message for a non-200 answer, empty when none was captured. */
  errorText() {
    try {
      const parsed = z
        .object({ error: z.object({ message: z.string() }) })
        .safeParse(JSON.parse(this.errorBody));

      return parsed.success ? parsed.data.error.message : this.errorBody;
    } catch {
      return this.errorBody;
    }
  }

  abort() {
    this.cancelled = true;
    this.controller.abort();
  }

  async close() {
    this.abort();
    await this.server.stop(true);
  }

  private compresses(payload: string, headers: Headers) {
    return (
      gzipEligible(this.upstream, this.options.env, this.options.gzip) &&
      Buffer.byteLength(payload) >= 4096 &&
      !headers.has("content-encoding")
    );
  }

  private async handle(request: Request) {
    const path = new URL(request.url);

    if (
      request.method !== "POST" ||
      path.pathname !== `${this.prefix}/v1/messages` ||
      request.headers.has("origin")
    )
      return new Response(null, { status: 404 });

    if (this.cancelled || this.used) {
      this.denied++;

      return new Response(DENIAL, {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    this.used = true;

    try {
      return await this.forward(request, path);
    } catch (error) {
      this.failure = error instanceof Error ? error.name : "Error";

      return new Response(null, { status: 502 });
    }
  }

  private async forward(request: Request, path: URL) {
    const { queried, oneShot, gzip } = this.options;
    let payload = await request.text();

    if (oneShot) payload = dropMessageBreakpoints(payload);

    try {
      payload = restoreQueriedTurn(payload, queried);
    } catch (error) {
      // Restoration is hygiene, not a gate: a frame it cannot prove lossless forwards as native built it.
      if (!(error instanceof QueriedTurnMismatch)) throw error;
    }

    payload = stableRequestContext(payload, queried);
    payload = pinMessageBreakpoint(payload, queried);
    payload = streamToolInput(payload);
    const headers = forwardedRequestHeaders(request);
    const route = `${this.upstream.origin}${this.upstream.pathname.replace(/\/$/, "")}/v1/messages${path.search}`;
    const compressed = this.compresses(payload, request.headers);

    const send = (gzip: boolean) => {
      const sent = new Headers(headers);

      if (gzip) sent.set("content-encoding", "gzip");

      return fetch(route, {
        method: "POST",
        headers: sent,
        body: gzip ? gzipPayload(payload) : payload,
        signal: this.controller.signal,
      });
    };

    let response = await send(compressed);
    let prefix: Uint8Array | undefined;

    if (compressed && [400, 403, 415].includes(response.status)) {
      // Recorded before the body read, so a failed read still reports this answer as an identity send would.
      this.status = response.status;
      prefix = new Uint8Array(await response.arrayBuffer());

      const reason = rejectionKind(
        response.status,
        response.headers,
        new TextDecoder().decode(prefix.slice(0, 8192)),
      );

      if (reason) {
        this.status = undefined;
        gzip.disable(reason);
        console.warn(
          `request gzip disabled: ${reason} status=${response.status}`,
        );

        if (this.cancelled) return new Response(null, { status: 499 });
        response = await send(false);
        prefix = undefined;
      }
    }

    this.status = response.status;

    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();

    void this.pipe(response, prefix, writable.getWriter());

    return new Response(readable, {
      status: response.status,
      headers: forwardedResponseHeaders(response),
    });
  }

  private async pipe(
    response: Response,
    prefix: Uint8Array | undefined,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    const idle = Math.min(this.timeoutMs, UPSTREAM_IDLE_MS);

    const deliver = async (chunk: Uint8Array) => {
      if (response.status === 200) this.capture.feed(chunk);
      else if (this.errorBody.length < 65536)
        // The rejection reason ("prompt is too long"), bounded.
        this.errorBody += new TextDecoder().decode(chunk);
      await writer.write(chunk);
    };

    try {
      if (prefix) await deliver(prefix);
      else if (response.body) {
        const reader = response.body.getReader();

        for (;;) {
          let timer: ReturnType<typeof setTimeout> | undefined;

          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new UpstreamIdle(idle / 1000)),
                idle,
              );
            }),
          ]).finally(() => clearTimeout(timer));

          if (result.done) break;
          await deliver(result.value);
        }
      }

      await writer.close();
    } catch (error) {
      this.failure = error instanceof Error ? error.name : "Error";
      this.controller.abort();
      await writer.abort(error).catch(() => undefined);
    }
  }
}
