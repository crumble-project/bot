export const PUSH_PLATFORMS = ["macos", "ios", "android"] as const;

export const PUSH_TRANSPORTS = ["apns", "fcm"] as const;

export const PUSH_ENVIRONMENTS = ["development", "production"] as const;

/** How long a notification stays deliverable; a provider's expiry must not outlast the outbox's. */
export const PUSH_TTL_SECONDS = 86400;
