import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type net from "node:net";
import { Transform } from "node:stream";
import tls from "node:tls";
import {
  hostMatches,
  type CredentialGrant,
  type CredentialUse,
} from "../shared/domain";
import { isPublicAddress } from "../workspaces/public-address";
import type { WorkspaceInterceptor } from "../workspaces/workspace-proxy";

export type CredentialProxyOptions = {
  agentId: string;
  authorities: {
    context(agentId: string, host: string): Promise<tls.SecureContext>;
  };
  /** Read for every request, so a changed or deleted credential applies at once. */
  grants: () => CredentialGrant[];
  recordUse: (name: string, use: Omit<CredentialUse, "id">) => void;
  lookup?: (host: string) => Promise<string[]>;
  isPublicAddress?: (address: string) => boolean;
  /** Extra certificate authorities upstream servers may use, in PEM; the system's are always trusted. */
  upstreamCa?: string;
};

// Shorter values would match ordinary bytes in responses; a reflected one that short is not worth corrupting bodies.
const MIN_SCRUBBED_LENGTH = 8;

// Hop-by-hop headers belong to the connection with the workspace; Node sets its own towards the upstream.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "accept-encoding",
]);

const latin1 = (text: string) => Buffer.from(text, "utf8").toString("latin1");

/** Replaces each `from` with its `to` in a byte stream, also across chunk boundaries. */
function replacing(pairs: ReadonlyArray<readonly [string, string]>) {
  const keep = Math.max(...pairs.map(([from]) => from.length)) - 1;
  let pending = "";

  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      let text = pending + chunk.toString("latin1");

      for (const [from, to] of pairs) text = text.replaceAll(from, to);
      const cut = Math.max(0, text.length - keep);

      pending = text.slice(cut);
      done(null, Buffer.from(text.slice(0, cut), "latin1"));
    },
    flush(done) {
      done(null, Buffer.from(pending, "latin1"));
    },
  });
}

const swappedHeaderValue = (
  key: string,
  value: string,
  swap: (text: string) => string,
) => {
  const basic = key === "authorization" && /^basic\s+(\S+)$/i.exec(value);

  if (!basic) return swap(value);

  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8");

  return `Basic ${Buffer.from(swap(decoded)).toString("base64")}`;
};

/** The headers towards the upstream server, with credentials swapped in and hop-by-hop headers dropped. */
export const requestHeaders = (
  rawHeaders: string[],
  swap: (text: string) => string,
) => {
  const headers: Record<string, string[]> = {};

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]!.toLowerCase();

    if (HOP_BY_HOP.has(key)) continue;

    (headers[key] ??= []).push(
      swappedHeaderValue(key, rawHeaders[index + 1]!, swap),
    );
  }

  return headers;
};

// A scrubbed body can change length; Node frames it anew.
const forwardable = (key: string, scrubbing: boolean) =>
  !HOP_BY_HOP.has(key) && !(scrubbing && key === "content-length");

/** The headers towards the workspace, with credential values scrubbed and hop-by-hop headers dropped. */
export const responseHeaders = (
  rawHeaders: string[],
  scrubbing: boolean,
  scrubText: (text: string) => string,
) => {
  const headers: Record<string, string[]> = {};

  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]!.toLowerCase();

    if (!forwardable(key, scrubbing)) continue;
    (headers[key] ??= []).push(scrubText(rawHeaders[index + 1]!));
  }

  return headers;
};

/**
 * Swaps a bot's credential placeholders for their values on requests to the credentials' hosts, and the values back
 * in responses. It sees only TLS connections the workspace proxy hands it, so a placeholder sent anywhere else, or from
 * another bot's workspace, stays a placeholder.
 */
export function credentialProxy(
  options: CredentialProxyOptions,
): WorkspaceInterceptor {
  const isPublic = options.isPublicAddress ?? isPublicAddress;

  const resolve =
    options.lookup ??
    (async (host: string) =>
      (await dns.lookup(host, { all: true })).map((entry) => entry.address));

  // Resolves once more for the upstream connection and keeps only public addresses, so a host that resolves to the
  // server's own network gets no credential.
  const publicLookup: LookupFunction = (host, lookupOptions, callback) => {
    resolve(host).then(
      (addresses) => {
        const found = addresses.filter(isPublic);

        if (!found.length)
          return callback(
            Object.assign(new Error(`${host} has no public address`), {
              code: "ENOTFOUND",
            }),
            "",
          );

        if (lookupOptions.all)
          return callback(
            null,
            found.map((address) => ({
              address,
              family: address.includes(":") ? 6 : 4,
            })),
          );

        callback(null, found[0]!, found[0]!.includes(":") ? 6 : 4);
      },
      (error: Error) => callback(error, ""),
    );
  };

  const relevant = (host: string) =>
    options.grants().filter((grant) => hostMatches(grant.hosts, host));

  const forward =
    (host: string, port: number) =>
    (request: http.IncomingMessage, response: http.ServerResponse) => {
      const grants = relevant(host);
      const used = new Set<string>();

      const swap = (text: string) =>
        grants.reduce((current, grant) => {
          if (!current.includes(grant.placeholder)) return current;
          used.add(grant.name);

          return current.replaceAll(grant.placeholder, grant.value);
        }, text);

      const headers = requestHeaders(request.rawHeaders, swap);

      // Uncompressed responses, so the value can be scrubbed from them.
      headers["accept-encoding"] = ["identity"];
      const path = swap(request.url ?? "/");
      const method = request.method ?? "GET";

      const record = (status: number | null) => {
        for (const name of used)
          options.recordUse(name, {
            at: new Date().toISOString(),
            method,
            host,
            path: path.split("?")[0]!,
            status,
          });
      };

      const scrub = grants
        .filter((grant) => grant.value.length >= MIN_SCRUBBED_LENGTH)
        .map(
          (grant) => [latin1(grant.value), latin1(grant.placeholder)] as const,
        );

      const scrubText = (text: string) =>
        scrub.reduce(
          (current, [from, to]) => current.replaceAll(from, to),
          text,
        );

      const upstream = https.request(
        {
          host,
          port,
          servername: host,
          method,
          path,
          headers,
          lookup: publicLookup,
          ...(options.upstreamCa && {
            ca: [...tls.rootCertificates, options.upstreamCa],
          }),
        },
        (reply) => {
          record(reply.statusCode ?? null);

          const replyHeaders = responseHeaders(
            reply.rawHeaders,
            scrub.length > 0,
            scrubText,
          );

          response.writeHead(
            reply.statusCode ?? 502,
            reply.statusMessage,
            replyHeaders,
          );

          if (scrub.length) reply.pipe(replacing(scrub)).pipe(response);
          else reply.pipe(response);
        },
      );

      upstream.on("error", (error) => {
        record(null);

        if (response.headersSent) return void response.destroy();
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`Crumble credential proxy: ${error.message}\n`);
      });
      request.pipe(upstream);
    };

  return {
    wants: (host) => relevant(host).length > 0,
    async handle(client: net.Socket, host: string, port: number) {
      const secureContext = await options.authorities.context(
        options.agentId,
        host,
      );

      const secure = new tls.TLSSocket(client, {
        isServer: true,
        secureContext,
        // HTTP/2 would need its own relay; clients fall back to HTTP/1.1.
        ALPNProtocols: ["http/1.1"],
      });

      secure.on("error", () => secure.destroy());
      // The TLS socket takes over reading the client; resuming the client as well stalls the handshake in Bun.
      http.createServer(forward(host, port)).emit("connection", secure);
    },
  };
}
