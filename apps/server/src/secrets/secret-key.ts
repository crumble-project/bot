/** A secret's key in the store, such as `github-account:<id>`; parts are escaped so a prefix never matches by accident. */
export const secretKey = (kind: string, ...ids: readonly string[]) =>
  [kind, ...ids.map(encodeURIComponent)].join(":");

/** A key under the bot's prefix, so deleting the bot deletes the secret. */
export const botSecretKey = (agentId: string, ...ids: readonly string[]) =>
  secretKey("bot", agentId, ...ids);

/** The prefix of every `botSecretKey` that starts with `ids`, for deleting a bot's or a login's secrets at once. */
export const botSecretsPrefix = (agentId: string, ...ids: readonly string[]) =>
  `${botSecretKey(agentId, ...ids)}:`;
