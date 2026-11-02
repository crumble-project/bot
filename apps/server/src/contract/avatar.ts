import { z } from "@hono/zod-openapi";
import type { AvatarDefinition } from "open-bot-avatar";
import { avatarDefinitionSchema as persistedAvatar } from "../shared/avatar-definition";

/** Named transport contract, derived from the same fields and validator as persisted input. */
export const avatarDefinitionSchema = z
  .object(persistedAvatar.shape)
  .openapi("BotAvatarDefinition");

export type BotAvatarDefinition = z.infer<typeof avatarDefinitionSchema>;

const palette = [
  "#8b5cf6",
  "#38bdf8",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#ec4899",
];

// Approximate the old bodies, without retaining the old canvas renderer, mouths or toppers.
const silhouettes = [
  ["circle", "M50 10A40 40 0 1 1 50 90A40 40 0 1 1 50 10Z"],
  [
    "squircle",
    "M30 12H70Q88 12 88 30V70Q88 88 70 88H30Q12 88 12 70V30Q12 12 30 12Z",
  ],
  [
    "pill",
    "M40 10H60A28 28 0 0 1 88 38V62A28 28 0 0 1 60 90H40A28 28 0 0 1 12 62V38A28 28 0 0 1 40 10Z",
  ],
  [
    "triangle",
    "M50 10Q54 10 58 18L90 76Q94 86 82 88H18Q6 86 10 76L42 18Q46 10 50 10Z",
  ],
  ["hexagon", "M30 12H70L92 50L70 88H30L8 50Z"],
  [
    "cloud",
    "M24 80C6 80 6 56 18 50C8 28 34 12 46 24C60 6 88 24 80 42C100 52 94 80 76 80Z",
  ],
  ["drop", "M50 10C64 30 88 48 88 62A38 28 0 0 1 12 62C12 48 36 30 50 10Z"],
] as const;

function legacyOptions(bot: { id: string; avatar: string }) {
  const prefix = ["bot:", "critters:"].find((each) =>
    bot.avatar.startsWith(each),
  );

  const [saved = "", ...options] = prefix
    ? bot.avatar.slice(prefix.length).split(";")
    : [];

  const seed = saved.trim() || bot.id.trim() || "crumble";
  let silhouette: string | undefined;
  let color: string | undefined;

  for (const option of options) {
    const [key, value] = option.split("=");

    if (key === "silhouette") silhouette = value;

    if (key === "color") color = palette.find((each) => each === value);
  }

  return { seed, silhouette, color };
}

/** Same FNV seed, silhouette order and palette as the retired web renderer. Never rewrites the seed string. */
export function legacyAvatarDefinition(bot: {
  id: string;
  avatar: string;
}): BotAvatarDefinition {
  const { seed, silhouette, color } = legacyOptions(bot);
  let hash = 1469598103934665603n;

  for (const byte of new TextEncoder().encode(seed))
    hash = ((hash ^ BigInt(byte)) * 1099511628211n) & ((1n << 64n) - 1n);

  const [id, path] =
    silhouettes.find(([each]) => each === silhouette) ??
    silhouettes[Number(hash % 7n)]!;

  const definition: AvatarDefinition = {
    version: 1,
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    body: { path },
    eyes: {
      x: 50,
      y: id === "triangle" || id === "drop" ? 58 : 50,
      spacing: 16,
      scale: 1,
    },
  };

  return {
    definition,
    color: color ?? palette[Number(hash % 8n)]!,
    eyeColor: "#151515",
  };
}
