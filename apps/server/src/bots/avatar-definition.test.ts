import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_COLOR,
  DEFAULT_EYE_COLOR,
  examples,
  validateAvatar,
  renderAvatarSvg,
} from "open-bot-avatar";
import { Store } from "../../test/support/store";
import { agentInput } from "../contract/agents";
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
});
