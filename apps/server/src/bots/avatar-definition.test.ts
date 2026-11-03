import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  DEFAULT_COLOR,
  DEFAULT_EYE_COLOR,
  examples,
  validateAvatar,
  renderAvatarSvg,
} from "open-bot-avatar";
import { Store } from "../../test/support/store";
import { agentInput } from "../shared/domain";
import {
  avatarDefinitionSchema,
  defaultAvatarDefinition,
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
  test("selects valid library gallery defaults deterministically from bot IDs", () => {
    const selected = new Set<string>();

    for (const id of [
      "",
      "crumble",
      "🤖",
      ...Array.from({ length: 100 }, (_, i) => `bot-${i}`),
    ]) {
      const look = defaultAvatarDefinition(id);
      expect(defaultAvatarDefinition(id)).toEqual(look);
      expect(examples).toContainEqual(look.definition);
      expect(look.color).toBe(DEFAULT_COLOR);
      expect(look.eyeColor).toBe(DEFAULT_EYE_COLOR);
      expect(avatarDefinitionSchema.safeParse(look).success).toBe(true);
      expect(validateAvatar(look.definition).ok).toBe(true);
      expect(renderAvatarSvg(look.definition)).toContain("<path");
      selected.add(look.definition.id);
    }

    expect(selected.size).toBeGreaterThan(1);
  });

  test("replaces legacy rows with fresh ID-derived defaults regardless of seed, silhouette or color", () => {
    const dir = make();
    const first = new Store(dir);
    const bot = first.createAgent(input, "fresh-look");
    expect(bot.avatar).toEqual(defaultAvatarDefinition(bot.id));
    first.close();
    const db = new Database(join(dir, "store.sqlite"));

    for (const avatar of [
      "bot:one;silhouette=cloud;color=#38bdf8",
      "critters:two;silhouette=drop;color=#ef4444",
      "bot:other;silhouette=hexagon;color=#22c55e",
      "critters:;color=bad",
      "sparkles",
      "",
    ]) {
      db.run("UPDATE agents SET avatar = ? WHERE id = ?", [avatar, bot.id]);
      const upgraded = new Store(dir);
      expect(upgraded.getAgent(bot.id)?.avatar).toEqual(
        defaultAvatarDefinition(bot.id),
      );
      expect(upgraded.getAgent(bot.id)?.updatedAt).toBe(bot.updatedAt);
      upgraded.close();
    }

    db.close();
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

  test("persists canonical avatars across creates, copies, partial updates and reopen", () => {
    const dir = make();
    const first = new Store(dir);
    const bot = first.createAgent(input);
    expect(bot.avatar).toEqual(defaultAvatarDefinition(bot.id));
    const imported = first.createAgent({ ...input, avatar: custom });
    expect(imported.avatar).toEqual(custom);
    first.updateAgent(bot.id, { avatar: custom });
    expect(
      first.updateAgent(bot.id, { name: "Partial update" })?.avatar,
    ).toEqual(custom);
    const copy = first.duplicateAgent(bot.id)!;
    expect(copy.avatar).toEqual(custom);
    first.close();
    const reopened = new Store(dir);
    expect(reopened.getAgent(bot.id)?.avatar).toEqual(custom);
    expect(reopened.getAgent(copy.id)?.avatar).toEqual(custom);
    expect(reopened.getAgent(imported.id)?.avatar).toEqual(custom);
    expect(() =>
      reopened.updateAgent(bot.id, { avatar: { ...custom, eyeColor: "bad" } }),
    ).toThrow();
    expect(reopened.getAgent(bot.id)?.avatar).toEqual(custom);
    reopened.close();
  });

  for (const schema of ["base", "additive"] as const)
    test(`upgrades ${schema} schema to one avatar column and preserves explicit definitions verbatim`, () => {
      const dir = make();
      const first = new Store(dir);
      const imported = first.createAgent({ ...input, avatar: custom });
      const legacy = first.createAgent(input);
      first.close();
      const db = new Database(join(dir, "store.sqlite"));
      const saved = JSON.stringify(custom, null, 2);

      if (schema === "additive") {
        db.run(
          "ALTER TABLE agents ADD COLUMN avatar_definition text; DELETE FROM __drizzle_migrations WHERE id = (SELECT MAX(id) FROM __drizzle_migrations)",
        );
        db.run(
          "UPDATE agents SET avatar = ?, avatar_definition = ? WHERE id = ?",
          ["bot:old;silhouette=cloud;color=#38bdf8", saved, imported.id],
        );
      } else {
        db.run(
          "DELETE FROM __drizzle_migrations WHERE id IN (SELECT id FROM __drizzle_migrations ORDER BY id DESC LIMIT 2)",
        );
        db.run("UPDATE agents SET avatar = ? WHERE id = ?", [
          saved,
          imported.id,
        ]);
      }

      db.run("UPDATE agents SET avatar = ? WHERE id = ?", [
        "critters:old;silhouette=drop;color=#ef4444",
        legacy.id,
      ]);
      const upgraded = new Store(dir);
      expect(upgraded.getAgent(imported.id)?.avatar).toEqual(custom);
      expect(upgraded.getAgent(imported.id)?.updatedAt).toBe(
        imported.updatedAt,
      );
      expect(upgraded.getAgent(legacy.id)?.avatar).toEqual(
        defaultAvatarDefinition(legacy.id),
      );
      expect(upgraded.getAgent(legacy.id)?.updatedAt).toBe(legacy.updatedAt);
      expect(
        db
          .query<{ avatar: string }, [string]>(
            "SELECT avatar FROM agents WHERE id = ?",
          )
          .get(imported.id)!.avatar,
      ).toBe(saved);
      expect(
        db
          .query<{ name: string }, []>("PRAGMA table_info(agents)")
          .all()
          .map((column) => column.name),
      ).not.toContain("avatar_definition");
      upgraded.close();
      const reopened = new Store(dir);
      expect(reopened.getAgent(imported.id)?.avatar).toEqual(custom);
      expect(reopened.getAgent(legacy.id)?.avatar).toEqual(
        defaultAvatarDefinition(legacy.id),
      );
      reopened.close();
      db.close();
    });

  test("normalizes historical bot proposals without resetting explicit choices or decisions", () => {
    const dir = make();
    const first = new Store(dir);
    const bot = first.createAgent(input);
    first.close();
    const db = new Database(join(dir, "store.sqlite"));

    const proposals = [
      { name: "Legacy", avatar: "bot:old;silhouette=cloud;color=#38bdf8" },
      { name: "Custom", avatar: custom },
      { name: "Additive", avatar: "critters:old", avatarDefinition: custom },
    ];

    for (const [index, proposal] of proposals.entries()) {
      db.run(
        "INSERT INTO bot_requests (id, agent_id, proposal, reason, status, requested_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          `request-${index}`,
          bot.id,
          JSON.stringify(proposal),
          "Keep reason",
          index === 0 ? "pending" : "declined",
          bot.createdAt,
          index === 0 ? null : bot.createdAt,
        ],
      );
    }

    const upgraded = new Store(dir);

    const rows = db
      .query<
        {
          id: string;
          proposal: string;
          reason: string;
          status: string;
          requested_at: string;
          decided_at: string | null;
        },
        []
      >("SELECT * FROM bot_requests ORDER BY id")
      .all();

    for (const [index, row] of rows.entries()) {
      const proposal = JSON.parse(row.proposal);
      expect(agentInput.safeParse(proposal).success).toBe(true);
      expect(proposal.avatar).toEqual(
        index === 0 ? defaultAvatarDefinition(row.id) : custom,
      );
      expect(proposal).not.toHaveProperty("avatarDefinition");
      expect(row.reason).toBe("Keep reason");
      expect(row.requested_at).toBe(bot.createdAt);
      expect(row.status).toBe(index === 0 ? "pending" : "declined");
      expect(row.decided_at).toBe(index === 0 ? null : bot.createdAt);
    }

    upgraded.close();
    db.close();
  });
});
