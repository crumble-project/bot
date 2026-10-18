# Native push contract

The server exposes authenticated native push registration for macOS, iOS, and Android. Every request below uses the same bearer token as the rest of `/v1`.

`GET /v1/push` returns `{ "serverId": "…", "transports": { "apns": true, "fcm": false } }`. The server ID is generated once and persisted in `push.sqlite`.

`PUT /v1/push/devices/:installationId` accepts a UUID installation ID and:

```json
{
  "platform": "macos|ios|android",
  "transport": "apns|fcm",
  "token": "provider token",
  "environment": "development|production",
  "bundleId": "com.example.app",
  "enabled": true
}
```

The response is `{ "serverId": "…", "remoteDelivery": true }`; provider tokens are never echoed. Re-registering an installation atomically rotates its token and does not reset presence. `DELETE` is idempotent and returns 204. `PUT /v1/push/devices/:id/presence` accepts `{active:boolean,agentId:string|null}`, returns 204, and returns 404 for an unknown installation. Active leases expire after 120 seconds; clients should refresh every 30 seconds.

Completed replies create one durable outbox event, independent of SSE listeners. Bot-originated replies are suppressed at the server. A device with an unexpired active presence for the same agent is suppressed. Clients should use `eventId` (the execution ID) and `serverId` for deduplication. The payload is:

```json
{
  "type": "reply",
  "eventId": "execution UUID",
  "serverId": "server UUID",
  "agentId": "agent UUID",
  "agentName": "Bot",
  "entryId": "entry UUID or null",
  "origin": "owner|task",
  "preview": "…",
  "createdAt": "ISO-8601"
}
```

APNs sends an alert with the bot name, preview, and default sound, plus the complete event fields (`agentName`, `preview`, and nullable `entryId`) in the root payload. FCM sends high-priority data-only messages with a 24-hour TTL; all values are strings and `entryId` is an empty string when null. Delivery retries with bounded exponential backoff, disables a registration only when its token still matches the rejected token, expires old outbox entries, and never logs tokens or credentials. Delivery is best effort.

## Configuration

APNs requires all of these variables (partial configuration fails startup):

- `CRUMBLE_APNS_TEAM_ID`
- `CRUMBLE_APNS_KEY_ID`
- `CRUMBLE_APNS_PRIVATE_KEY_PATH` (p8 file path)
- `CRUMBLE_APNS_ALLOWED_TOPICS` (comma-separated bundle IDs, for these clients `dev.crumble.desktop,dev.crumble-project.ios`)

FCM requires `CRUMBLE_FCM_SERVICE_ACCOUNT_PATH`, pointing to a Google service-account JSON file. The server uses OAuth JWT and FCM HTTP v1 without an additional dependency. If neither transport is configured, the API remains available and reports both transports as false.

Real delivery still requires the Apple Developer APNs entitlement/provisioning setup or a Firebase project/service account. This repository does not provision credentials or claim live provider delivery in tests. Presence is a short lease and must be refreshed while a chat is visible.

Provider setup references: [Apple remote notification configuration](https://developer.apple.com/documentation/usernotifications/setting_up_a_remote_notification_server), [Apple APNs provider API](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [Firebase HTTP v1 send](https://firebase.google.com/docs/cloud-messaging/send-message), and [Firebase HTTP v1 error codes](https://firebase.google.com/docs/cloud-messaging/error-codes).


## Resume deferred setup

Provider credentials and provisioning are intentionally unconfigured for this change.
Without provider configuration, clients retain their existing local notification fallback.
No live APNs or FCM delivery is asserted by the automated tests.

For APNs, provide a signing key file outside the repository, its key ID, and its
Apple team ID. Add each provisioned client's actual bundle ID to
`CRUMBLE_APNS_ALLOWED_TOPICS`. The macOS bundle is `dev.crumble.desktop`; the iOS
bundle is `dev.crumble-project.ios`. Each Apple app needs a matching App ID with
Push Notifications enabled and a refreshed provisioning profile.

For Android, use a Firebase project with Cloud Messaging enabled, matching client
configuration, and a service account authorized to send messages to that project.
Keep service-account JSON and APNs keys out of client bundles and source control.

The outbox retries temporary failures up to eight attempts, with delays of 1, 2,
4, 8, 16, 32, and 64 seconds. Events expire after 24 hours. Auth failures retry
within this bound; invalid payloads terminate that delivery with a sanitized
provider-state warning. A permanently rejected token disables only the matching
registration. A rotated token keeps its queued delivery for a subsequent attempt.

Presence is best effort. A stale active-chat lease can suppress delivery for up to
120 seconds after abrupt app termination. Successful provider acceptance is not
proof that the operating system displayed the alert. Focus, user permissions,
connectivity, provider coalescing, and device settings can affect presentation.
