export const secretKey = (kind: string, ...ids: ReadonlyArray<string>) =>
  [kind, ...ids.map(encodeURIComponent)].join(":");

export const botSecretKey = (agentId: string, ...ids: ReadonlyArray<string>) =>
  secretKey("bot", agentId, ...ids);

export const botSecretsPrefix = (
  agentId: string,
  ...ids: ReadonlyArray<string>
) => `${botSecretKey(agentId, ...ids)}:`;
