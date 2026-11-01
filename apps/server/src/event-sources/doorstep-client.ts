import { Effect } from "effect";
import { z } from "zod";
import { InvalidInput } from "../shared/errors";

const createdSource = z.object({ id: z.string().min(1), url: z.url() });

export type RelayAccess = { url: string; token: string };

const endpoint = (relayUrl: string, path: string) =>
  new URL(path, relayUrl.endsWith("/") ? relayUrl : `${relayUrl}/`);

const request = (access: RelayAccess, path: string, init: RequestInit) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(endpoint(access.url, path), {
        ...init,
        signal,
        headers: { Authorization: `Bearer ${access.token}` },
      }),
    catch: () => new InvalidInput({ message: "Can't reach the event relay" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () =>
        Effect.fail(
          new InvalidInput({ message: "Can't reach the event relay" }),
        ),
    }),
    Effect.filterOrFail(
      (response) => response.status !== 401,
      () =>
        new InvalidInput({
          message: "The relay rejected the account token",
        }),
    ),
  );

const unexpected = (response: Response) =>
  new InvalidInput({
    message: `The event relay answered ${response.status}`,
  });

/** Creates a source on the relay; its address carries the source's secret and is returned only now. */
export const createSource = Effect.fnUntraced(function* (access: RelayAccess) {
  const response = yield* request(access, "v1/sources", { method: "POST" });

  if (response.status !== 201) return yield* unexpected(response);

  const body = createdSource.safeParse(
    yield* Effect.promise(() => response.json().catch(() => undefined)),
  );

  if (!body.success)
    return yield* new InvalidInput({
      message: "The event relay sent an unexpected answer",
    });

  return body.data;
});

/** Deletes a source on the relay; one the relay no longer knows counts as deleted. */
export const deleteSource = Effect.fnUntraced(function* (
  access: RelayAccess,
  id: string,
) {
  const response = yield* request(
    access,
    `v1/sources/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

  if (response.status !== 204 && response.status !== 404)
    return yield* unexpected(response);
});

/** The relay's consumer WebSocket address. */
export const connectUrl = (relayUrl: string) => {
  const url = endpoint(relayUrl, "v1/connect");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.toString();
};
