export const secretKey = (kind: string, ...ids: readonly string[]) =>
  [kind, ...ids.map(encodeURIComponent)].join(":");

export const botSecretKey = (agentId: string, ...ids: readonly string[]) =>
  secretKey("bot", agentId, ...ids);

export const botSecretsPrefix = (agentId: string, ...ids: readonly string[]) =>
  `${botSecretKey(agentId, ...ids)}:`;
