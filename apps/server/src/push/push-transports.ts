import { existsSync, readFileSync } from "node:fs";
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { connect } from "node:http2";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
  notificationPreview,
  notificationTitle,
  type PushDevice,
  type PushDeviceInput,
  type PushTransportName,
  type ReplyPushEvent,
} from "./push-model";

/** The provider rejected the device's token; the device is disabled unless its token has rotated since. */
export class PermanentRejection extends Schema.TaggedError<PermanentRejection>()(
  "PermanentRejection",
  { message: Schema.String },
) {}

/** The provider refused this notification for good; retrying cannot deliver it. */
export class TerminalResponse extends Schema.TaggedError<TerminalResponse>()(
  "TerminalResponse",
  { message: Schema.String },
) {}

/** Any other send failure; the outbox retries it with persisted backoff until it expires. */
export class TemporaryFailure extends Schema.TaggedError<TemporaryFailure>()(
  "TemporaryFailure",
  { message: Schema.String },
) {}

export type SendFailure =
  | PermanentRejection
  | TerminalResponse
  | TemporaryFailure;

/** Sends notifications to one provider; a send fails with what retrying it can achieve. */
export type PushTransport = {
  readonly send: (
    device: PushDevice,
    event: ReplyPushEvent,
  ) => Effect.Effect<"delivered" | "expired", SendFailure>;
  readonly canSend?: (device: PushDeviceInput) => boolean;
};

/** The server's push configuration is incomplete or invalid. */
export class PushConfigError extends Schema.TaggedError<PushConfigError>()(
  "PushConfigError",
  { message: Schema.String },
) {}

/** The transports this server can deliver through, configured from its environment. */
export class PushTransports extends Context.Service<
  PushTransports,
  Record<PushTransportName, PushTransport | undefined>
>()("crumble/push/PushTransports") {
  static readonly layer = Layer.effect(
    PushTransports,
    Effect.suspend(() => loadPushTransports(process.env)),
  );
}

const b64 = (v: Uint8Array | string) => Buffer.from(v).toString("base64url");

const ServiceAccount = Schema.Struct({
  project_id: Schema.NonEmptyString,
  client_email: Schema.NonEmptyString,
  private_key: Schema.NonEmptyString,
});

type ServiceAccount = typeof ServiceAccount.Type;

export type ApnsSettings = {
  teamId: string;
  keyId: string;
  keyPath: string;
  topics: Set<string>;
};

const configError = (message: string) =>
  new PushConfigError({ message: `Push configuration: ${message}` });

const temporaryFailure = (cause: unknown) =>
  new TemporaryFailure({ message: String(cause) });

/** What a provider's success status means: neither provider confirms the device showed it. */
export const deliveryOutcome = (status: number): "delivered" | "expired" =>
  status >= 200 && status < 300 ? "delivered" : "expired";

const apnsTopics = (allowedTopics: string) =>
  new Set(
    allowedTopics
      .split(",")
      .map((topic) => topic.trim())
      .filter(Boolean),
  );

/** The APNs settings the environment names; `undefined` when it names none. */
export const loadApnsSettings = Effect.fnUntraced(function* (
  env: Record<string, string | undefined>,
): Effect.fn.Return<ApnsSettings | undefined, PushConfigError> {
  const teamId = env["CRUMBLE_APNS_TEAM_ID"];
  const keyId = env["CRUMBLE_APNS_KEY_ID"];
  const keyPath = env["CRUMBLE_APNS_PRIVATE_KEY_PATH"];
  const allowedTopics = env["CRUMBLE_APNS_ALLOWED_TOPICS"];

  if (![teamId, keyId, keyPath, allowedTopics].some(Boolean)) return undefined;

  if (!(teamId && keyId && keyPath && allowedTopics))
    return yield* configError(
      "APNs requires TEAM_ID, KEY_ID, PRIVATE_KEY_PATH, and ALLOWED_TOPICS",
    );

  const topics = apnsTopics(allowedTopics);

  if (!topics.size)
    return yield* configError(
      "APNs ALLOWED_TOPICS must contain at least one topic",
    );

  if (!existsSync(keyPath))
    return yield* configError("APNs private key file does not exist");

  yield* Effect.try({
    try: () => createPrivateKey(readFileSync(keyPath)),
    catch: () => configError("APNs private key file is invalid"),
  });

  return { teamId, keyId, keyPath, topics };
});

/** The FCM service account the environment names; `undefined` when it names none. */
export const loadFcmSettings = Effect.fnUntraced(function* (
  env: Record<string, string | undefined>,
): Effect.fn.Return<ServiceAccount | undefined, PushConfigError> {
  const path = env["CRUMBLE_FCM_SERVICE_ACCOUNT_PATH"];

  if (!path) return undefined;

  if (!existsSync(path))
    return yield* configError("FCM service account file does not exist");

  const account = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(ServiceAccount),
  )(readFileSync(path, "utf8")).pipe(
    Effect.mapError(() => configError("FCM service account is incomplete")),
  );

  yield* Effect.try({
    try: () => createPrivateKey(account.private_key),
    catch: () => configError("FCM service account private key is invalid"),
  });

  return account;
});

export const loadPushTransports = Effect.fnUntraced(function* (
  env: Record<string, string | undefined>,
) {
  const apns = yield* loadApnsSettings(env);
  const fcm = yield* loadFcmSettings(env);

  return {
    apns: apns ? apnsTransport(apns) : undefined,
    fcm: fcm ? fcmTransport(fcm) : undefined,
  };
});

const ApnsResponse = Schema.fromJsonString(
  Schema.Struct({ reason: Schema.optionalKey(Schema.String) }),
);

/** One APNs request; resolves with the HTTP status and Apple's `reason`, if the body names one. */
function apnsRequest(
  host: string,
  headers: Record<string, string>,
  body: string,
) {
  const client = connect(host);

  return new Promise<{ status: number; reason: string | undefined }>(
    (resolve, reject) => {
      const req = client.request(headers);
      let responseBody = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          req.destroy(new Error("APNs request timed out"));
          reject(new Error("APNs request timed out"));
        }
      }, 15_000);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      client.once("error", fail);
      req.on("response", (h) => {
        const status = Number(h[":status"]);
        req.setEncoding("utf8");
        req.on("data", (chunk) => (responseBody += chunk));
        req.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          const reason = Schema.decodeUnknownOption(ApnsResponse)(
            responseBody,
          ).pipe(
            Option.flatMap((parsed) => Option.fromNullishOr(parsed.reason)),
            Option.getOrUndefined,
          );

          resolve({ status, reason });
        });
      });
      req.on("error", fail);
      req.end(body);
    },
  ).finally(() => client.close());
}

/** The APNs host for the device's environment. */
export const apnsHost = (environment: PushDevice["environment"]) =>
  environment === "development"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";

/** A signed APNs provider token; the key file is read per send so a rotated key needs no restart. */
export function apnsJwt(settings: ApnsSettings, seconds: number) {
  const key = createPrivateKey(readFileSync(settings.keyPath));
  const head = b64(JSON.stringify({ alg: "ES256", kid: settings.keyId }));
  const claims = b64(JSON.stringify({ iss: settings.teamId, iat: seconds }));
  const signer = createSign("SHA256");
  signer.update(`${head}.${claims}`);
  signer.end();

  return `${head}.${claims}.${b64(signer.sign({ key, dsaEncoding: "ieee-p1363" }))}`;
}

/** The APNs headers for one notification; the collapse ID replaces the notification for the same answer. */
export function apnsHeaders(
  topic: string,
  device: PushDevice,
  event: ReplyPushEvent,
  jwt: string,
  seconds: number,
) {
  return {
    ":method": "POST",
    ":path": `/3/device/${device.token}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": topic,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(seconds + 86400),
    "apns-collapse-id": createHash("sha256")
      .update(`${event.serverId}:${event.agentId}`)
      .digest("hex")
      .slice(0, 64),
    "content-type": "application/json",
  };
}

/** The APNs alert payload: the shown notification plus the fields the app renders the answer from. */
export function apnsPayload(event: ReplyPushEvent) {
  return {
    aps: {
      alert: {
        title: notificationTitle(event),
        body: notificationPreview(event.preview),
      },
      sound: "default",
    },
    type: event.type,
    eventId: event.eventId,
    serverId: event.serverId,
    agentId: event.agentId,
    agentName: event.agentName,
    entryId: event.entryId,
    preview: event.preview,
    origin: event.origin,
    createdAt: event.createdAt,
    ...(event.groupId && {
      groupId: event.groupId,
      groupName: event.groupName,
    }),
    ...(event.jobName && { jobName: event.jobName }),
  };
}

const apnsRejectedTokens = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

/** How a retry should treat the response; `undefined` when the notification was accepted or expired. */
export function classifyApnsResponse(
  status: number,
  reason: string | undefined,
): SendFailure | undefined {
  if (
    status === 410 ||
    (reason !== undefined && apnsRejectedTokens.has(reason))
  )
    return new PermanentRejection({ message: "APNs rejected token" });

  if (status >= 500 || status === 429)
    return new TemporaryFailure({
      message: `APNs temporary failure ${status}`,
    });

  if (status >= 400 && status !== 401 && status !== 403)
    return new TerminalResponse({
      message: `APNs terminal response ${status}`,
    });

  return undefined;
}

function apnsTransport(settings: ApnsSettings): PushTransport {
  const { topics } = settings;

  return {
    canSend: (device) => !!device.bundleId && topics.has(device.bundleId),
    send: Effect.fn("APNs.send")(function* (device, event) {
      const topic = device.bundleId;

      if (!topic || !topics.has(topic))
        return yield* new TemporaryFailure({
          message: "APNs bundle topic is not allowed",
        });

      const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
      const jwt = apnsJwt(settings, seconds);

      const { status, reason } = yield* Effect.tryPromise({
        try: () =>
          apnsRequest(
            apnsHost(device.environment),
            apnsHeaders(topic, device, event, jwt, seconds),
            JSON.stringify(apnsPayload(event)),
          ),
        catch: temporaryFailure,
      });

      const failure = classifyApnsResponse(status, reason);

      if (failure) return yield* failure;

      return deliveryOutcome(status);
    }),
  };
}

const FcmToken = Schema.Struct({ access_token: Schema.String });

const FcmError = Schema.Struct({
  error: Schema.optionalKey(
    Schema.Struct({
      details: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ errorCode: Schema.optionalKey(Schema.String) }),
        ),
      ),
    }),
  ),
});

/** The FCM data payload: everything the app needs to render the answer itself. */
export function fcmData(event: ReplyPushEvent) {
  return {
    type: event.type,
    eventId: event.eventId,
    serverId: event.serverId,
    agentId: event.agentId,
    agentName: event.agentName,
    entryId: event.entryId ?? "",
    origin: event.origin,
    preview: event.preview,
    createdAt: event.createdAt,
    ...(event.groupId && {
      groupId: event.groupId,
      groupName: event.groupName ?? "",
    }),
    ...(event.jobName && { jobName: event.jobName }),
  } satisfies Record<string, string>;
}

/** The FCM message body for one device. */
export function fcmMessage(device: PushDevice, event: ReplyPushEvent) {
  return {
    message: {
      token: device.token,
      data: fcmData(event),
      android: { priority: "HIGH", ttl: "86400s" },
    },
  };
}

const fcmRejectedTokens = new Set(["UNREGISTERED", "SENDER_ID_MISMATCH"]);

/** How a retry should treat the response; `undefined` when the message was accepted. */
export function classifyFcmResponse(
  status: number,
  errorCode: string | undefined,
): SendFailure | undefined {
  if (errorCode !== undefined && fcmRejectedTokens.has(errorCode))
    return new PermanentRejection({ message: "FCM rejected token" });

  if (status === 429 || status >= 500)
    return new TemporaryFailure({ message: `FCM temporary failure ${status}` });

  if (status >= 400 && status !== 401 && status !== 403)
    return new TerminalResponse({ message: `FCM terminal response ${status}` });

  return undefined;
}

/** The error code the response body names; an unreadable body is classified from the status alone. */
export const fcmErrorCode = (
  response: Response,
): Effect.Effect<string | undefined> =>
  response.ok
    ? Effect.undefined
    : Effect.tryPromise(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(FcmError)),
        Effect.map(
          (body) =>
            body.error?.details?.find((detail) => detail.errorCode)?.errorCode,
        ),
        Effect.orElseSucceed(() => undefined),
      );

function fcmTransport(account: ServiceAccount): PushTransport {
  const accessToken = Effect.gen(function* () {
    const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));

    const claims = b64(
      JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: seconds,
        exp: seconds + 3600,
      }),
    );

    const signer = createSign("RSA-SHA256");
    signer.update(`${head}.${claims}`);
    signer.end();
    const assertion = `${head}.${claims}.${b64(signer.sign(account.private_key))}`;

    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
          signal: AbortSignal.timeout(15_000),
        }),
      catch: temporaryFailure,
    });

    if (!response.ok)
      return yield* new TemporaryFailure({
        message: `FCM OAuth failure ${response.status}`,
      });

    const body = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: temporaryFailure,
    });

    return (yield* Schema.decodeUnknownEffect(FcmToken)(body).pipe(
      Effect.mapError(temporaryFailure),
    )).access_token;
  });

  return {
    canSend: () => true,
    send: Effect.fn("FCM.send")(function* (device, event) {
      const token = yield* accessToken;

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(
            `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(fcmMessage(device, event)),
              signal: AbortSignal.timeout(15_000),
            },
          ),
        catch: temporaryFailure,
      });

      const errorCode = yield* fcmErrorCode(response);
      const failure = classifyFcmResponse(response.status, errorCode);

      if (failure) return yield* failure;

      return deliveryOutcome(response.status);
    }),
  };
}
