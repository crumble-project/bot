import type http from "node:http";
import { GUEST_CA_PATH } from "../../workspace-image/guest";
import type { WorkspaceInterceptor } from "../workspaces/workspace-proxy";
import { answerOverTls, type TlsAuthorities } from "./credential-proxy";

/** The git signing helper the server writes into every guest at boot; it asks the server to sign. */
export const GUEST_SIGN_PATH = "/usr/local/bin/crumble-ssh-sign";

/** The host the signing helper posts to; the interceptor answers it itself and never resolves it. */
export const SIGNING_HOST = "signing.crumble.internal";

const SIGNING_PATH = "/sign";

// A commit object is far smaller; a larger body is not a commit.
const MAX_SIGNED_BYTES = 1024 * 1024;

/**
 * git's `gpg.ssh.program` in the guest: posts the commit to `SIGNING_HOST` and writes the signature where git reads
 * it. Any address works for the connection: the workspace proxy routes by the TLS server name.
 */
export const signingHelper = () => `#!/bin/sh
set -eu
mode= file=
while [ $# -gt 0 ]; do
  case "$1" in
    -Y) mode=$2; shift 2 ;;
    -n|-f|-I|-s|-O) shift 2 ;;
    -*) shift ;;
    *) file=$1; shift ;;
  esac
done
if [ "$mode" != sign ] || [ -z "$file" ]; then
  echo "crumble-ssh-sign: only signing is supported here" >&2
  exit 1
fi
exec curl -fsS --max-time 30 --cacert ${GUEST_CA_PATH} \\
  --connect-to ${SIGNING_HOST}:443:192.0.2.1:443 \\
  --data-binary @"$file" -o "$file.sig" https://${SIGNING_HOST}${SIGNING_PATH}
`;

/** Signs the posted commit with the bot's key; 403 for a bot without one. */
async function answerSigning(
  sign: (data: Buffer) => Promise<string | undefined>,
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAX_SIGNED_BYTES) {
      response.writeHead(413, { "content-type": "text/plain" });

      return void response.end("Crumble signing: too large to be a commit\n");
    }

    chunks.push(chunk);
  }

  const signature =
    request.method === "POST" && request.url === SIGNING_PATH
      ? await sign(Buffer.concat(chunks))
      : undefined;

  if (signature === undefined) {
    response.writeHead(403, { "content-type": "text/plain" });

    return void response.end(
      "Crumble signing: this bot has no machine account to sign as\n",
    );
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end(signature);
}

/** Answers the signing helper at `SIGNING_HOST` over the bot's authority. */
export const commitSigning = (options: {
  agentId: string;
  authorities: TlsAuthorities;
  /** Signs a commit as the bot; undefined when it has no key to sign with. */
  sign: (data: Buffer) => Promise<string | undefined>;
}): WorkspaceInterceptor => ({
  wants: (host) => host === SIGNING_HOST,
  answers: (host) => host === SIGNING_HOST,
  handle: (client, host) =>
    answerOverTls(client, host, options, (request, response) => {
      answerSigning(options.sign, request, response).catch(() =>
        response.destroy(),
      );
    }),
});
