import { afterEach, describe, expect, test } from "bun:test";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
} from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { PushDevice, ReplyPushEvent } from "./push-model";
import {
  apnsHeaders,
  apnsHost,
  apnsJwt,
  apnsPayload,
  classifyApnsResponse,
  classifyFcmResponse,
  deliveryOutcome,
  fcmData,
  fcmErrorCode,
  fcmMessage,
  loadPushTransports,
  PermanentRejection,
  TemporaryFailure,
  TerminalResponse,
} from "./push-transports";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(join("/tmp", "crumble-push-transports-"));
  dirs.push(dir);

  return dir;
};

const writeFile = (dir: string, name: string, contents: string) => {
  const path = join(dir, name);
  writeFileSync(path, contents);

  return path;
};

const ecKey = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const rsaKey = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const apnsEnv = (keyPath: string) => ({
  CRUMBLE_APNS_TEAM_ID: "TEAM",
  CRUMBLE_APNS_KEY_ID: "KEY",
  CRUMBLE_APNS_PRIVATE_KEY_PATH: keyPath,
  CRUMBLE_APNS_ALLOWED_TOPICS: "com.example.app, com.example.other",
});

const device = (overrides: Partial<PushDevice> = {}): PushDevice => ({
  platform: "macos",
  transport: "apns",
  token: "token",
  environment: "production",
  bundleId: "com.example.app",
  enabled: true,
  installationId: "installation",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const event = (overrides: Partial<ReplyPushEvent> = {}): ReplyPushEvent => ({
  type: "reply",
  eventId: "event",
  serverId: "server",
  agentId: "agent",
  agentName: "Bot",
  entryId: null,
  origin: "owner",
  preview: "hi",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** The message of the configuration error loading `env` fails with. */
const configFailure = (env: Record<string, string>) =>
  Effect.runPromise(
    loadPushTransports(env).pipe(
      Effect.flip,
      Effect.map((error) => error.message),
    ),
  );

describe("push transport configuration", () => {
  test("a server without push variables registers no transports", async () => {
    const transports = await Effect.runPromise(loadPushTransports({}));

    expect(transports).toEqual({ apns: undefined, fcm: undefined });
  });

  test("APNs needs every variable or none", async () => {
    expect(await configFailure({ CRUMBLE_APNS_TEAM_ID: "TEAM" })).toBe(
      "Push configuration: APNs requires TEAM_ID, KEY_ID, PRIVATE_KEY_PATH, and ALLOWED_TOPICS",
    );
  });

  test("APNs rejects a topic list without topics", async () => {
    const dir = tempDir();
    const keyPath = writeFile(dir, "apns.p8", ecKey.privateKey);

    expect(
      await configFailure({
        ...apnsEnv(keyPath),
        CRUMBLE_APNS_ALLOWED_TOPICS: " , ",
      }),
    ).toBe(
      "Push configuration: APNs ALLOWED_TOPICS must contain at least one topic",
    );
  });

  test("APNs rejects a missing private key file", async () => {
    const dir = tempDir();

    expect(await configFailure(apnsEnv(join(dir, "missing.p8")))).toBe(
      "Push configuration: APNs private key file does not exist",
    );
  });

  test("APNs rejects an unreadable private key file", async () => {
    const dir = tempDir();
    const keyPath = writeFile(dir, "apns.p8", "not a key");

    expect(await configFailure(apnsEnv(keyPath))).toBe(
      "Push configuration: APNs private key file is invalid",
    );
  });

  test("APNs sends only to the bundle topics it allows", async () => {
    const dir = tempDir();
    const keyPath = writeFile(dir, "apns.p8", ecKey.privateKey);

    const transports = await Effect.runPromise(
      loadPushTransports(apnsEnv(keyPath)),
    );

    const canSend = transports.apns?.canSend;

    expect(canSend?.(device())).toBe(true);
    expect(canSend?.(device({ bundleId: "com.example.other" }))).toBe(true);
    expect(canSend?.(device({ bundleId: "com.example.unknown" }))).toBe(false);
    expect(canSend?.(device({ bundleId: undefined }))).toBe(false);
    expect(transports.fcm).toBeUndefined();
  });

  const serviceAccount = (dir: string, contents: string) =>
    writeFile(dir, "fcm.json", contents);

  test("FCM rejects a missing service account file", async () => {
    const dir = tempDir();

    expect(
      await configFailure({
        CRUMBLE_FCM_SERVICE_ACCOUNT_PATH: join(dir, "missing.json"),
      }),
    ).toBe("Push configuration: FCM service account file does not exist");
  });

  test("FCM rejects an incomplete service account", async () => {
    const dir = tempDir();

    expect(
      await configFailure({
        CRUMBLE_FCM_SERVICE_ACCOUNT_PATH: serviceAccount(
          dir,
          JSON.stringify({ project_id: "project" }),
        ),
      }),
    ).toBe("Push configuration: FCM service account is incomplete");
  });

  test("FCM rejects an unreadable service account private key", async () => {
    const dir = tempDir();

    expect(
      await configFailure({
        CRUMBLE_FCM_SERVICE_ACCOUNT_PATH: serviceAccount(
          dir,
          JSON.stringify({
            project_id: "project",
            client_email: "push@example.com",
            private_key: "not a key",
          }),
        ),
      }),
    ).toBe("Push configuration: FCM service account private key is invalid");
  });

  test("FCM serves every device once its service account is complete", async () => {
    const dir = tempDir();

    const transports = await Effect.runPromise(
      loadPushTransports({
        CRUMBLE_FCM_SERVICE_ACCOUNT_PATH: serviceAccount(
          dir,
          JSON.stringify({
            project_id: "project",
            client_email: "push@example.com",
            private_key: rsaKey.privateKey,
          }),
        ),
      }),
    );

    expect(transports.apns).toBeUndefined();
    expect(transports.fcm?.canSend?.(device())).toBe(true);
  });
});

describe("APNs requests", () => {
  const settings = (keyPath: string) => ({
    teamId: "TEAM",
    keyId: "KEY",
    keyPath,
    topics: new Set(["com.example.app"]),
  });

  test("the sandbox host serves development devices", () => {
    expect(apnsHost("development")).toBe("https://api.sandbox.push.apple.com");
    expect(apnsHost("production")).toBe("https://api.push.apple.com");
  });

  test("the provider token is signed with the configured key", () => {
    const dir = tempDir();
    const keyPath = writeFile(dir, "apns.p8", ecKey.privateKey);
    const jwt = apnsJwt(settings(keyPath), 1_700_000_000);
    const [head, claims, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: "TEAM",
      iat: 1_700_000_000,
    });
    expect(
      verify(
        "SHA256",
        Buffer.from(`${head}.${claims}`),
        { key: createPublicKey(ecKey.publicKey), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBe(true);
  });

  test("headers address the device token and expire a day after signing", () => {
    const headers = apnsHeaders(
      "com.example.app",
      device({ token: "device-token" }),
      event(),
      "jwt",
      1_000,
    );

    expect(headers).toEqual({
      ":method": "POST",
      ":path": "/3/device/device-token",
      authorization: "bearer jwt",
      "apns-topic": "com.example.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "87400",
      "apns-collapse-id": createHash("sha256")
        .update("server:agent")
        .digest("hex"),
      "content-type": "application/json",
    });
  });

  test("the alert shows the bot, the group, and the reply fields", () => {
    const payload = apnsPayload(
      event({
        agentName: "Ada",
        origin: "group",
        preview: "**Booked.**",
        groupId: "group-1",
        groupName: "Trip",
      }),
    );

    expect(payload.aps).toEqual({
      alert: { title: "Ada in Trip", body: "Booked." },
      sound: "default",
    });
    expect(payload).toMatchObject({
      type: "reply",
      eventId: "event",
      serverId: "server",
      agentId: "agent",
      agentName: "Ada",
      entryId: null,
      origin: "group",
      preview: "**Booked.**",
      createdAt: "2026-01-01T00:00:00.000Z",
      groupId: "group-1",
      groupName: "Trip",
    });
    expect(payload).not.toHaveProperty("jobName");
  });

  test("the alert carries a job name for a job report", () => {
    const payload = apnsPayload(
      event({ origin: "desktop", jobName: "github-login" }),
    );

    expect(payload.aps.alert.title).toBe("Bot");
    expect(payload).toHaveProperty("jobName", "github-login");
  });
});

describe("APNs response classification", () => {
  test("a token the provider no longer accepts is permanent", () => {
    expect(classifyApnsResponse(410, undefined)).toBeInstanceOf(
      PermanentRejection,
    );
    expect(classifyApnsResponse(400, "BadDeviceToken")).toBeInstanceOf(
      PermanentRejection,
    );
    expect(classifyApnsResponse(400, "Unregistered")).toBeInstanceOf(
      PermanentRejection,
    );
    expect(classifyApnsResponse(400, "DeviceTokenNotForTopic")).toBeInstanceOf(
      PermanentRejection,
    );
  });

  test("throttling and provider failures are temporary", () => {
    expect(classifyApnsResponse(429, undefined)).toBeInstanceOf(
      TemporaryFailure,
    );
    expect(classifyApnsResponse(500, undefined)).toBeInstanceOf(
      TemporaryFailure,
    );
    expect(classifyApnsResponse(503, "ServiceUnavailable")).toBeInstanceOf(
      TemporaryFailure,
    );
  });

  test("a refused notification is terminal but rejected credentials are not retried blindly", () => {
    expect(classifyApnsResponse(400, "PayloadTooLarge")).toBeInstanceOf(
      TerminalResponse,
    );
    expect(classifyApnsResponse(404, undefined)).toBeInstanceOf(
      TerminalResponse,
    );
    expect(classifyApnsResponse(401, "BadCertificate")).toBeUndefined();
    expect(classifyApnsResponse(403, "BadCertificate")).toBeUndefined();
    expect(classifyApnsResponse(200, undefined)).toBeUndefined();
  });

  test("a success status means delivered only inside the success range", () => {
    expect(deliveryOutcome(200)).toBe("delivered");
    expect(deliveryOutcome(204)).toBe("delivered");
    expect(deliveryOutcome(299)).toBe("delivered");
    expect(deliveryOutcome(199)).toBe("expired");
    expect(deliveryOutcome(300)).toBe("expired");
  });
});

describe("FCM requests", () => {
  test("data fills the fields the app expects to be present", () => {
    const data = fcmData(event());

    expect(data).toEqual({
      type: "reply",
      eventId: "event",
      serverId: "server",
      agentId: "agent",
      agentName: "Bot",
      entryId: "",
      origin: "owner",
      preview: "hi",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(data).not.toHaveProperty("groupId");
    expect(data).not.toHaveProperty("jobName");
  });

  test("data carries the group and job the answer came from", () => {
    expect(
      fcmData(event({ groupId: "group-1", jobName: "github-login" })),
    ).toMatchObject({
      groupId: "group-1",
      groupName: "",
      jobName: "github-login",
    });
  });

  test("the message targets one device with high priority", () => {
    expect(fcmMessage(device({ token: "device-token" }), event())).toEqual({
      message: {
        token: "device-token",
        data: fcmData(event()),
        android: { priority: "HIGH", ttl: "86400s" },
      },
    });
  });

  const errorCode = (body: string, status: number) =>
    Effect.runPromise(fcmErrorCode(new Response(body, { status })));

  test("a success response carries no error code", async () => {
    expect(await errorCode("", 200)).toBeUndefined();
  });

  test("the error code names the first detail that has one", async () => {
    expect(
      await errorCode(
        JSON.stringify({
          error: {
            details: [{ errorCode: "UNREGISTERED" }, { errorCode: "IGNORED" }],
          },
        }),
        400,
      ),
    ).toBe("UNREGISTERED");
  });

  test("a body without an error code is classified from the status alone", async () => {
    expect(
      await errorCode(JSON.stringify({ error: { details: [{}] } }), 400),
    ).toBeUndefined();
    expect(await errorCode("not json", 400)).toBeUndefined();
    expect(
      await errorCode(JSON.stringify({ error: { details: "nope" } }), 400),
    ).toBeUndefined();
  });
});

describe("FCM response classification", () => {
  test("a token the provider no longer accepts is permanent", () => {
    expect(classifyFcmResponse(404, "UNREGISTERED")).toBeInstanceOf(
      PermanentRejection,
    );
    expect(classifyFcmResponse(403, "SENDER_ID_MISMATCH")).toBeInstanceOf(
      PermanentRejection,
    );
  });

  test("throttling and provider failures are temporary", () => {
    expect(classifyFcmResponse(429, undefined)).toBeInstanceOf(
      TemporaryFailure,
    );
    expect(classifyFcmResponse(500, undefined)).toBeInstanceOf(
      TemporaryFailure,
    );
    expect(classifyFcmResponse(503, "UNAVAILABLE")).toBeInstanceOf(
      TemporaryFailure,
    );
  });

  test("a refused notification is terminal but rejected credentials are not retried blindly", () => {
    expect(classifyFcmResponse(400, "INVALID_ARGUMENT")).toBeInstanceOf(
      TerminalResponse,
    );
    expect(classifyFcmResponse(401, undefined)).toBeUndefined();
    expect(classifyFcmResponse(403, "PERMISSION_DENIED")).toBeUndefined();
    expect(classifyFcmResponse(200, undefined)).toBeUndefined();
  });
});
