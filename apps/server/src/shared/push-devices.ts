export const PUSH_PLATFORMS = ["macos", "ios", "android"] as const;

export const PUSH_TRANSPORTS = ["apns", "fcm"] as const;

export const PUSH_ENVIRONMENTS = ["development", "production"] as const;

export const PUSH_TTL_SECONDS = 86_400;
