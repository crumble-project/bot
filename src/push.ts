import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSign, createPrivateKey, createHash } from "node:crypto";

export type PushPlatform = "macos" | "ios" | "android";

export type PushTransportName = "apns" | "fcm";

export type PushDeviceInput = {
  platform: PushPlatform;
  transport: PushTransportName;
  token: string;
  environment: "development" | "production";
  bundleId?: string;
  enabled: boolean;
};

export type PushDevice = PushDeviceInput & {
  installationId: string;
  updatedAt: string;
};

export type ReplyPushEvent = {
  type: "reply";
  eventId: string;
  serverId: string;
  agentId: string;
  agentName: string;
  entryId: string | null;
  origin: string;
  preview: string;
  createdAt: string;
};

export function canonicalReplyEvent(
  event: {
    executionId?: string;
    eventId?: string;
    serverId?: string;
    agentId: string;
    agentName: string;
    entryId?: string | null;
    origin: string;
    preview: string;
    createdAt: string;
  },
  serverId: string,
): ReplyPushEvent {
  return {
    type: "reply",
    eventId: event.eventId ?? event.executionId!,
    serverId: event.serverId ?? serverId,
    agentId: event.agentId,
    agentName: event.agentName,
    entryId: event.entryId ?? null,
    origin: event.origin,
    preview: event.preview,
    createdAt: event.createdAt,
  };
}

export type PushTransport = {
  send(
    device: PushDevice,
    event: ReplyPushEvent,
  ): Promise<"delivered" | "expired">;
  canSend?(device: PushDeviceInput): boolean;
};

type PushDeviceRow = {
  installation_id: string;
  platform: PushPlatform;
  transport: PushTransportName;
  token: string;
  environment: "development" | "production";
  bundle_id: string | null;
  enabled: number;
  updated_at: string;
};

type PushPresenceRow = {
  active: number;
  agent_id: string | null;
  refreshed_at: number;
};

type PushOutboxRow = { id: string };

type PushPendingRow = {
  outbox_id: string;
  installation_id: string;
  event_json: string;
  expires_at: number;
  attempts: number;
};

type FcmTokenResponse = { access_token: string };

type FcmErrorResponse = { error?: { details?: Array<{ errorCode?: string }> } };

const iso = () => new Date().toISOString();
const b64 = (v: Uint8Array | string) => Buffer.from(v).toString("base64url");

export function notificationPreview(value: string) {
  const cleaned = value
    .replace(/\*\*|__|`|^\s*[#>]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return cleaned || "Replied";
}

export class PushStore {
  private db: Database;
  constructor(
    private readonly dataDir: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.db = new Database(join(dataDir, "push.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_devices (
        installation_id TEXT PRIMARY KEY, platform TEXT NOT NULL, transport TEXT NOT NULL,
        token TEXT NOT NULL, environment TEXT NOT NULL, bundle_id TEXT, enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_presence (
        installation_id TEXT PRIMARY KEY REFERENCES push_devices(installation_id) ON DELETE CASCADE,
        active INTEGER NOT NULL, agent_id TEXT, refreshed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_outbox (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_delivery (
        outbox_id TEXT NOT NULL REFERENCES push_outbox(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL REFERENCES push_devices(installation_id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(outbox_id, installation_id)
      );
    `);
  }
  close() {
    this.db.close();
  }
  serverId() {
    // SAFETY: The query selects the nullable settings `value` column.
    const row = this.db
      .query("SELECT value FROM push_settings WHERE key='server_id'")
      .get() as { value: string } | null;

    if (row) return row.value;
    const value = crypto.randomUUID();
    this.db
      .query("INSERT INTO push_settings(key,value) VALUES('server_id',?)")
      .run(value);

    return value;
  }
  upsertDevice(installationId: string, input: PushDeviceInput): PushDevice {
    const updatedAt = iso();
    this.db
      .query(
        `INSERT INTO push_devices(installation_id,platform,transport,token,environment,bundle_id,enabled,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET platform=excluded.platform,transport=excluded.transport,
      token=excluded.token,environment=excluded.environment,bundle_id=excluded.bundle_id,enabled=excluded.enabled,updated_at=excluded.updated_at`,
      )
      .run(
        installationId,
        input.platform,
        input.transport,
        input.token,
        input.environment,
        input.bundleId ?? null,
        input.enabled ? 1 : 0,
        updatedAt,
      );
    // Registration never resets a lease; first registration starts inactive.
    this.db
      .query(
        "INSERT OR IGNORE INTO push_presence(installation_id,active,agent_id,refreshed_at) VALUES(?,0,NULL,?)",
      )
      .run(installationId, this.clock());

    return this.getDevice(installationId)!;
  }
  getDevice(id: string): PushDevice | null {
    // SAFETY: The query selects every column from push_devices, matching PushDeviceRow.
    const r = this.db
      .query("SELECT * FROM push_devices WHERE installation_id=?")
      .get(id) as PushDeviceRow | null;

    if (!r) return null;

    const device: PushDevice = {
      installationId: r.installation_id,
      platform: r.platform,
      transport: r.transport,
      token: r.token,
      environment: r.environment,
      enabled: !!r.enabled,
      updatedAt: r.updated_at,
    };

    if (r.bundle_id) device.bundleId = r.bundle_id;

    return device;
  }
  deleteDevice(id: string) {
    this.db.query("DELETE FROM push_devices WHERE installation_id=?").run(id);
  }
  setPresence(id: string, active: boolean, agentId: string | null) {
    if (!this.getDevice(id)) return false;
    this.db
      .query(
        "INSERT INTO push_presence(installation_id,active,agent_id,refreshed_at) VALUES(?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET active=excluded.active,agent_id=excluded.agent_id,refreshed_at=excluded.refreshed_at",
      )
      .run(id, active ? 1 : 0, agentId, this.clock());

    return true;
  }
  devices() {
    // SAFETY: The query selects every column from push_devices, matching PushDeviceRow.
    const rows = this.db
      .query("SELECT * FROM push_devices WHERE enabled=1")
      .all() as PushDeviceRow[];

    return rows.map((r) => this.getDevice(r.installation_id)!);
  }
  isSuppressed(id: string, agentId: string) {
    // SAFETY: The query selects the three named push_presence columns.
    const r = this.db
      .query(
        "SELECT active,agent_id,refreshed_at FROM push_presence WHERE installation_id=?",
      )
      .get(id) as PushPresenceRow | null;

    return (
      !!r?.active &&
      r.agent_id === agentId &&
      this.clock() - Number(r.refreshed_at) <= 120_000
    );
  }
  enqueue(event: ReplyPushEvent, ttlMs = 24 * 60 * 60 * 1000) {
    this.db.transaction(() => {
      const outboxId = crypto.randomUUID();
      const expires = this.clock() + ttlMs;
      this.db
        .query(
          "INSERT OR IGNORE INTO push_outbox(id,event_id,event_json,created_at,expires_at) VALUES(?,?,?,?,?)",
        )
        .run(outboxId, event.eventId, JSON.stringify(event), iso(), expires);

      // SAFETY: The query selects the push_outbox primary key by its known `id` column.
      const row = this.db
        .query("SELECT id FROM push_outbox WHERE event_id=?")
        .get(event.eventId) as PushOutboxRow;

      for (const d of this.devices())
        this.db
          .query(
            "INSERT OR IGNORE INTO push_delivery(outbox_id,installation_id,next_attempt_at) VALUES(?,?,?)",
          )
          .run(row.id, d.installationId, this.clock());
    })();
  }
  pending(limit = 100) {
    // SAFETY: The query selects the named delivery and outbox columns used by PushManager.
    return this.db
      .query(
        `SELECT d.*,o.event_json,o.expires_at,p.active,p.agent_id,p.refreshed_at FROM push_delivery d JOIN push_outbox o ON o.id=d.outbox_id JOIN push_devices v ON v.installation_id=d.installation_id LEFT JOIN push_presence p ON p.installation_id=d.installation_id WHERE d.delivered=0 AND d.next_attempt_at<=? AND v.enabled=1 ORDER BY d.next_attempt_at LIMIT ?`,
      )
      .all(this.clock(), limit) as PushPendingRow[];
  }
  markDelivered(outboxId: string, installationId: string) {
    this.db
      .query(
        "UPDATE push_delivery SET delivered=1 WHERE outbox_id=? AND installation_id=?",
      )
      .run(outboxId, installationId);
  }
  markRetry(
    outboxId: string,
    installationId: string,
    attempts: number,
    next: number,
  ) {
    this.db
      .query(
        "UPDATE push_delivery SET attempts=?,next_attempt_at=? WHERE outbox_id=? AND installation_id=?",
      )
      .run(attempts, next, outboxId, installationId);
  }
  removeDelivery(outboxId: string, installationId: string) {
    this.db
      .query(
        "DELETE FROM push_delivery WHERE outbox_id=? AND installation_id=?",
      )
      .run(outboxId, installationId);
  }
  requeueDelivery(outboxId: string, installationId: string) {
    this.db
      .query(
        "INSERT OR REPLACE INTO push_delivery(outbox_id,installation_id,attempts,next_attempt_at,delivered) VALUES(?,?,0,?,0)",
      )
      .run(outboxId, installationId, this.clock());
  }
  disableIfToken(installationId: string, token: string) {
    this.db
      .query(
        "UPDATE push_devices SET enabled=0 WHERE installation_id=? AND token=?",
      )
      .run(installationId, token);
  }
  cleanup() {
    this.db
      .query("DELETE FROM push_outbox WHERE expires_at<=?")
      .run(this.clock());
  }
}

function configError(message: string): never {
  throw new Error(`Push configuration: ${message}`);
}

export function loadPushTransports(
  env: Record<string, string | undefined> = process.env,
): Record<PushTransportName, PushTransport | undefined> {
  const out: Record<PushTransportName, PushTransport | undefined> = {
    apns: undefined,
    fcm: undefined,
  };

  const apns = [
    env.CRUMBLE_APNS_TEAM_ID,
    env.CRUMBLE_APNS_KEY_ID,
    env.CRUMBLE_APNS_PRIVATE_KEY_PATH,
    env.CRUMBLE_APNS_ALLOWED_TOPICS,
  ];

  if (apns.some(Boolean) && apns.some((v) => !v))
    configError(
      "APNs requires TEAM_ID, KEY_ID, PRIVATE_KEY_PATH, and ALLOWED_TOPICS",
    );

  if (apns.every(Boolean)) {
    if (
      !env.CRUMBLE_APNS_ALLOWED_TOPICS!.split(",").some((topic) => topic.trim())
    )
      configError("APNs ALLOWED_TOPICS must contain at least one topic");

    if (!existsSync(env.CRUMBLE_APNS_PRIVATE_KEY_PATH!))
      configError("APNs private key file does not exist");

    try {
      createPrivateKey(readFileSync(env.CRUMBLE_APNS_PRIVATE_KEY_PATH!));
    } catch {
      configError("APNs private key file is invalid");
    }

    out.apns = new APNsTransport(
      env.CRUMBLE_APNS_TEAM_ID!,
      env.CRUMBLE_APNS_KEY_ID!,
      env.CRUMBLE_APNS_PRIVATE_KEY_PATH!,
      new Set(
        env
          .CRUMBLE_APNS_ALLOWED_TOPICS!.split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    );
  }

  const fcm = env.CRUMBLE_FCM_SERVICE_ACCOUNT_PATH;

  if (fcm) {
    if (!existsSync(fcm))
      configError("FCM service account file does not exist");
    const account = JSON.parse(readFileSync(fcm, "utf8"));

    if (!account.project_id || !account.client_email || !account.private_key)
      configError("FCM service account is incomplete");

    try {
      createPrivateKey(account.private_key);
    } catch {
      configError("FCM service account private key is invalid");
    }

    out.fcm = new FCMTransport(account);
  }

  return out;
}

class APNsTransport implements PushTransport {
  constructor(
    private teamId: string,
    private keyId: string,
    private keyPath: string,
    private topics: Set<string>,
  ) {}
  canSend(device: PushDeviceInput) {
    return !!device.bundleId && this.topics.has(device.bundleId);
  }
  async send(device: PushDevice, event: ReplyPushEvent) {
    const topic = device.bundleId;

    if (!topic || !this.topics.has(topic))
      throw new Error("APNs bundle topic is not allowed");
    const key = createPrivateKey(readFileSync(this.keyPath));
    const head = b64(JSON.stringify({ alg: "ES256", kid: this.keyId }));

    const body = b64(
      JSON.stringify({ iss: this.teamId, iat: Math.floor(Date.now() / 1000) }),
    );

    const signer = createSign("SHA256");
    signer.update(`${head}.${body}`);
    signer.end();
    const jwt = `${head}.${body}.${b64(signer.sign({ key, dsaEncoding: "ieee-p1363" }))}`;
    const http2 = await import("node:http2");

    const host =
      device.environment === "development"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";

    const client = http2.connect(host);

    try {
      const result = await new Promise<{ status: number; reason?: string }>(
        (resolve, reject) => {
          const req = client.request({
            ":method": "POST",
            ":path": `/3/device/${device.token}`,
            authorization: `bearer ${jwt}`,
            "apns-topic": topic,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400),
            "apns-collapse-id": createHash("sha256")
              .update(`${event.serverId}:${event.agentId}`)
              .digest("hex")
              .slice(0, 64),
            "content-type": "application/json",
          });

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
              let reason: string | undefined;

              try {
                reason = JSON.parse(responseBody).reason;
              } catch {
                /* empty success body */
              }

              resolve({ status, reason });
            });
          });
          req.on("error", fail);
          req.end(
            JSON.stringify({
              aps: {
                alert: {
                  title: event.agentName,
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
            }),
          );
        },
      );

      const { status, reason } = result;

      if (
        status === 410 ||
        reason === "BadDeviceToken" ||
        reason === "Unregistered" ||
        reason === "DeviceTokenNotForTopic"
      )
        throw Object.assign(new Error("APNs rejected token"), {
          permanent: true,
        });

      if (status >= 500 || status === 429)
        throw new Error(`APNs temporary failure ${status}`);

      if (status >= 400 && status !== 401 && status !== 403)
        throw Object.assign(new Error(`APNs terminal response ${status}`), {
          terminal: true,
        });

      return status >= 200 && status < 300 ? "delivered" : "expired";
    } finally {
      client.close();
    }
  }
}

class FCMTransport implements PushTransport {
  constructor(private account: any) {}
  canSend(_device: PushDeviceInput) {
    return true;
  }
  private async accessToken() {
    const now = Math.floor(Date.now() / 1000);
    const h = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));

    const p = b64(
      JSON.stringify({
        iss: this.account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    );

    const signer = createSign("RSA-SHA256");
    signer.update(`${h}.${p}`);
    signer.end();
    const assertion = `${h}.${p}.${b64(signer.sign(this.account.private_key))}`;

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) throw new Error(`FCM OAuth failure ${response.status}`);

    // SAFETY: A successful token response contains the documented access_token string.
    const body = (await response.json()) as FcmTokenResponse;

    return body.access_token;
  }
  async send(device: PushDevice, event: ReplyPushEvent) {
    const token = await this.accessToken();

    const data = {
      type: event.type,
      eventId: event.eventId,
      serverId: event.serverId,
      agentId: event.agentId,
      agentName: event.agentName,
      entryId: event.entryId ?? "",
      origin: event.origin,
      preview: event.preview,
      createdAt: event.createdAt,
    } satisfies Record<string, string>;

    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: device.token,
            data,
            android: { priority: "HIGH", ttl: "86400s" },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    let errorCode: string | undefined;

    if (!response.ok) {
      try {
        // SAFETY: FCM error responses optionally contain the documented nested details array.
        const body = (await response.json()) as FcmErrorResponse;
        errorCode = body?.error?.details?.find(
          (d: any) => d?.errorCode,
        )?.errorCode;
      } catch {
        /* classify from status below */
      }
    }

    if (errorCode === "UNREGISTERED" || errorCode === "SENDER_ID_MISMATCH")
      throw Object.assign(new Error("FCM rejected token"), { permanent: true });

    if (response.status === 429 || response.status >= 500)
      throw new Error(`FCM temporary failure ${response.status}`);

    if (
      response.status >= 400 &&
      response.status !== 401 &&
      response.status !== 403
    )
      throw Object.assign(
        new Error(`FCM terminal response ${response.status}`),
        { terminal: true },
      );

    return response.ok ? "delivered" : "expired";
  }
}

export class PushManager {
  readonly serverId: string;
  readonly transports: Record<PushTransportName, PushTransport | undefined>;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private draining?: Promise<void>;
  private closed = false;
  constructor(
    private store: PushStore,
    transports = loadPushTransports(),
    private now = Date.now,
  ) {
    this.serverId = store.serverId();
    this.transports = transports;
  }
  attach(service: { onActivity(callback: (event: any) => void): () => void }) {
    this.unsubscribe = service.onActivity((event) => {
      if (event.type === "reply" && event.origin !== "bot") this.enqueue(event);
    });
    this.timer = setInterval(() => void this.drain(), 1000);
  }
  private enqueue(event: any) {
    if (this.closed) return;

    const push = canonicalReplyEvent(
      {
        ...event,
        createdAt: event.createdAt ?? new Date(this.now()).toISOString(),
      },
      this.serverId,
    );

    this.store.enqueue(push);
    void this.drain();
  }
  async drain() {
    if (this.draining) return this.draining;
    this.draining = this.drainOnce();

    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
  }
  private async drainOnce() {
    for (const row of this.store.pending()) {
      const d = this.store.getDevice(row.installation_id);

      if (!d) continue;

      if (row.expires_at <= this.now()) {
        this.store.removeDelivery(row.outbox_id, d.installationId);
        continue;
      }

      // SAFETY: Outbox entries are written exclusively from ReplyPushEvent values.
      const event = JSON.parse(row.event_json) as ReplyPushEvent;

      if (this.store.isSuppressed(d.installationId, event.agentId)) {
        this.store.markDelivered(row.outbox_id, d.installationId);
        continue;
      }

      const transport = this.transports[d.transport];

      if (!transport) {
        this.store.markDelivered(row.outbox_id, d.installationId);
        continue;
      }

      if (transport.canSend && !transport.canSend(d)) {
        this.store.markDelivered(row.outbox_id, d.installationId);
        continue;
      }

      try {
        const result = await transport.send(d, event);

        if (result === "delivered") {
          this.store.markDelivered(row.outbox_id, d.installationId);
        } else {
          this.store.removeDelivery(row.outbox_id, d.installationId);
          console.warn(
            "Push delivery reached a terminal provider state",
            d.transport,
          );
        }
      } catch (error: any) {
        if (error?.permanent) {
          const current = this.store.getDevice(d.installationId);

          if (current?.token === d.token) {
            this.store.disableIfToken(d.installationId, d.token);
            this.store.removeDelivery(row.outbox_id, d.installationId);
          } else if (current) {
            this.store.requeueDelivery(row.outbox_id, d.installationId);
          } else {
            this.store.removeDelivery(row.outbox_id, d.installationId);
          }
        } else if (error?.terminal) {
          this.store.removeDelivery(row.outbox_id, d.installationId);
          console.warn(
            "Push delivery reached a terminal provider state",
            d.transport,
          );
        } else if (row.attempts >= 7 || row.expires_at <= this.now())
          this.store.removeDelivery(row.outbox_id, d.installationId);
        else
          this.store.markRetry(
            row.outbox_id,
            d.installationId,
            row.attempts + 1,
            this.now() + Math.min(300000, 1000 * 2 ** row.attempts),
          );
      }
    }

    this.store.cleanup();
  }
  device(id: string, input: PushDeviceInput) {
    this.store.upsertDevice(id, input);
    const transport = this.transports[input.transport];

    return {
      serverId: this.serverId,
      remoteDelivery:
        input.enabled &&
        !!transport &&
        (!transport.canSend || transport.canSend(input)),
    };
  }
  remove(id: string) {
    this.store.deleteDevice(id);
  }
  presence(id: string, active: boolean, agentId: string | null) {
    return this.store.setPresence(id, active, agentId);
  }
  async close() {
    this.closed = true;

    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    await this.drain();
    this.store.close();
  }
}
