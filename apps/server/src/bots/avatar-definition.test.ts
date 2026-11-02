import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { examples, validateAvatar, renderAvatarSvg } from "open-bot-avatar";
import { Store } from "../../test/support/store";
import { agentInput } from "../shared/domain";
import {
  avatarDefinitionSchema,
  legacyAvatarDefinition,
} from "../contract/avatar";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), "avatar-store-"));
  dirs.push(dir);

  return dir;
};

const input = agentInput.parse({ name: "Avatar" });
const custom = { definition: examples[0]!, color: "#123abc", eyeColor: "#fed" };

describe("portable bot avatars", () => {
  test("converts every legacy silhouette, prefix and palette without blank bodies", () => {
    for (const prefix of ["bot:", "critters:"])
      for (const silhouette of [
        "circle",
        "squircle",
        "pill",
        "triangle",
        "hexagon",
        "cloud",
        "drop",
      ])
        for (const color of [
          "#8b5cf6",
          "#38bdf8",
          "#14b8a6",
          "#22c55e",
          "#f59e0b",
          "#f97316",
          "#ef4444",
          "#ec4899",
        ]) {
          const avatar = `${prefix}familiar;silhouette=${silhouette};color=${color}`;
          const migrated = legacyAvatarDefinition({ id: "ignored", avatar });
          expect(migrated.definition.id).toBe(silhouette);
          expect(migrated.color).toBe(color);
          expect(validateAvatar(migrated.definition).ok).toBe(true);
          expect(renderAvatarSvg(migrated.definition)).toContain("<path");
        }
  });

  test("uses the old FNV palette and id fallback deterministically", () => {
    const byId = legacyAvatarDefinition({ id: "crumble", avatar: "sparkles" });

    const bySeed = legacyAvatarDefinition({
      id: "other",
      avatar: "bot:crumble",
    });

    expect(byId).toEqual(bySeed);
    expect(bySeed.color).toBe("#f97316");
    expect(avatarDefinitionSchema.safeParse(bySeed).success).toBe(true);
    expect(
      legacyAvatarDefinition({ id: "", avatar: "critters:;color=bad" }),
    ).toEqual(byId);
  });

  test("rejects invalid geometry, markup, empty paths, extra fields and colors", () => {
    expect(avatarDefinitionSchema.safeParse(custom).success).toBe(true);

    for (const definition of [
      { ...custom.definition, body: { path: "" } },
      { ...custom.definition, body: { path: "<script>alert(1)</script>" } },
      { ...custom.definition, body: { path: "M0 0H100V100H0Z" } },
      { ...custom.definition, eyes: { x: 0, y: 0, spacing: 16, scale: 1 } },
      { ...custom.definition, onclick: "bad" },
    ])
      expect(
        avatarDefinitionSchema.safeParse({ ...custom, definition }).success,
      ).toBe(false);

    for (const color of ["red", "#12", "url(javascript:bad)", "#12345678"])
      expect(
        avatarDefinitionSchema.safeParse({ ...custom, color }).success,
      ).toBe(false);

    const outside = avatarDefinitionSchema.safeParse({
      ...custom,
      definition: {
        ...custom.definition,
        eyes: { x: 0, y: 0, spacing: 16, scale: 1 },
      },
    });

    expect(outside.success).toBe(false);

    if (!outside.success)
      expect(outside.error.message).toContain("eyes must sit inside the body");
  });

  test("persists fresh creates, copies, partial native updates and custom definitions on reopen", () => {
    const dir = make();
    const first = new Store(dir);
    const oldSeed = "critters:familiar;silhouette=cloud;color=#38bdf8";
    const bot = first.createAgent({ ...input, avatar: oldSeed });
    expect(bot.avatarDefinition?.definition.id).toBe("cloud");
    first.updateAgent(bot.id, { avatarDefinition: custom });
    expect(
      first.updateAgent(bot.id, { name: "Native update" })?.avatarDefinition,
    ).toEqual(custom);
    expect(first.getAgent(bot.id)?.avatar).toBe(oldSeed);
    const copy = first.duplicateAgent(bot.id)!;
    expect(copy.avatarDefinition).toEqual(custom);
    expect(copy.avatar).toBe(oldSeed);
    first.close();
    const reopened = new Store(dir);
    expect(reopened.getAgent(bot.id)?.avatarDefinition).toEqual(custom);
    expect(reopened.getAgent(copy.id)?.avatarDefinition).toEqual(custom);
    expect(reopened.getAgent(bot.id)?.avatar).toBe(oldSeed);
    expect(() =>
      reopened.updateAgent(bot.id, {
        avatarDefinition: { ...custom, eyeColor: "bad" },
      }),
    ).toThrow();
    expect(reopened.getAgent(bot.id)?.avatarDefinition).toEqual(custom);
    reopened.close();
  });

  test("upgrades the preceding schema and backfills once without rewriting legacy values", () => {
    const dir = make();
    const first = new Store(dir);

    const seeds = [
      "bot:one;silhouette=cloud;color=#38bdf8",
      "critters:two;silhouette=drop;color=#ef4444",
      "sparkles",
    ];

    const bots = seeds.map((avatar) => first.createAgent({ ...input, avatar }));
    first.close();
    const db = new Database(join(dir, "store.sqlite"));
    db.run(
      "ALTER TABLE agents DROP COLUMN avatar_definition; DELETE FROM __drizzle_migrations WHERE id = (SELECT MAX(id) FROM __drizzle_migrations)",
    );
    db.close();
    const upgraded = new Store(dir);

    for (const bot of bots) {
      const next = upgraded.getAgent(bot.id)!;
      expect(next.avatar).toBe(bot.avatar);
      expect(next.updatedAt).toBe(bot.updatedAt);
      expect(next.avatarDefinition).toEqual(legacyAvatarDefinition(bot));
      expect(
        avatarDefinitionSchema.safeParse(next.avatarDefinition).success,
      ).toBe(true);
    }

    upgraded.updateAgent(bots[0]!.id, { avatarDefinition: custom });
    upgraded.close();
    const check = new Database(join(dir, "store.sqlite"));
    expect(
      check
        .query(
          "SELECT COUNT(*) AS n FROM agents WHERE avatar_definition IS NULL",
        )
        .get(),
    ).toEqual({ n: 0 });
    // An older binary can write a bot without the additive field after rollback.
    check.run("UPDATE agents SET avatar_definition = NULL WHERE id = ?", [
      bots[1]!.id,
    ]);
    check.close();
    const reopened = new Store(dir);
    expect(reopened.getAgent(bots[0]!.id)?.avatarDefinition).toEqual(custom);
    expect(reopened.getAgent(bots[1]!.id)?.avatarDefinition).toEqual(
      legacyAvatarDefinition(bots[1]!),
    );
    reopened.close();
  });
});
