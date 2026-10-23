# Native push contract

Authenticated push notification registration and delivery for iOS and Android (and optional macOS APNs), under `/v1/push`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/push` | Returns `{ serverId, transports: { apns, fcm } }`. |
| `PUT` | `/v1/push/devices/:installationId` | Registers `{ platform, transport, token, environment, bundleId, enabled }` and returns `{ serverId, remoteDelivery }`. |
| `DELETE` | `/v1/push/devices/:installationId` | Removes a device registration (`204`). |
| `PUT` | `/v1/push/devices/:installationId/presence` | Refreshes `{ active, agentId }` presence lease (expires after 120s; refresh every 30s). |

## Outbox and payload

Completed owner, task, job-report, and group replies create a durable outbox event in `push.sqlite`. Replies are suppressed for devices holding an active presence lease on the same bot chat. Retries use exponential backoff (1s to 64s, up to 8 attempts, 24h expiry); permanently rejected tokens disable only the matching registration.

```json
{
  "type": "reply",
  "eventId": "execution UUID",
  "serverId": "server UUID",
  "agentId": "agent UUID",
  "agentName": "Bot",
  "entryId": "entry UUID or null",
  "origin": "owner|task|coding|desktop",
  "jobName": "optional job name",
  "groupId": "optional group UUID",
  "groupName": "optional group name",
  "preview": "…",
  "createdAt": "ISO-8601"
}
```

- **APNs:** Sends an alert with the bot/group title, preview, default sound, and full root payload fields. Requires `CRUMBLE_APNS_TEAM_ID`, `CRUMBLE_APNS_KEY_ID`, `CRUMBLE_APNS_PRIVATE_KEY_PATH`, and `CRUMBLE_APNS_ALLOWED_TOPICS`.
- **FCM:** Sends high-priority data-only HTTP v1 messages (string values, `""` for null `entryId`). Requires `CRUMBLE_FCM_SERVICE_ACCOUNT_PATH`.
- **Fallback:** When neither provider is configured, `remoteDelivery` is `false` and clients post local notifications from `/v1/events`.
