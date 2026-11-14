import { describe, expect, test } from "bun:test";
import {
  eventRequest,
  gatewayRequest,
  scheduleRequest,
  scriptRequest,
  voiceCallRequest,
  voiceRequest,
} from "../shared/request-ids";
import { frameInput } from "./input-framing";

const QUIET_NOTE =
  "[An automation started this turn. If it asks you to tell the owner something every time, do. Otherwise reply only when this run found something the owner needs to know; if it found nothing, react with 👍 and write nothing.]";

describe("input framing", () => {
  test("a spoken message tells the model its reply is read aloud", () => {
    const requestId = voiceRequest("c1", "u1");

    expect(
      frameInput("hello", { kind: "owner", via: "voice" }, requestId),
    ).toBe(
      `[message ${requestId}]\n[Spoken on a phone call. Your reply is read aloud: answer briefly in plain sentences, without lists, tables, code, or links. Saying goodbye does not end the call: when the owner says goodbye or asks you to hang up, call hang_up.]\nhello`,
    );
  });

  test.each([
    [
      "typed",
      { kind: "owner" as const },
      "0b0e1f2a-5b1c-4a9e-8f00-000000000000",
    ],
    [
      "Discord",
      { kind: "owner" as const, via: "discord" },
      gatewayRequest("discord", "u1"),
    ],
  ])("a %s owner message carries no spoken note", (_, origin, requestId) => {
    expect(frameInput("hello", origin, requestId)).toBe(
      `[message ${requestId}]\nhello`,
    );
  });

  test("only a call notice carries the wake-up instructions, and only in the model's copy", () => {
    const framed = frameInput(
      "Call ended after 4 minutes.",
      { kind: "call" },
      voiceCallRequest("c1", "ended"),
    );

    expect(framed).toStartWith("[Call ended after 4 minutes.]\n");
    expect(framed).toContain("react with 👍 and write nothing");
    expect(framed).not.toContain("[message ");

    for (const origin of [
      { kind: "owner" as const },
      { kind: "owner" as const, via: "voice" },
      { kind: "credential" as const, name: "TOKEN" },
    ])
      expect(
        frameInput("hello", origin, voiceRequest("c1", "u1")),
      ).not.toContain("react with 👍");
  });

  test.each([
    [
      "scheduled",
      { kind: "task" as const, name: "Inbox check" },
      scheduleRequest("s1", "2026-11-14T08:00:00.000Z"),
    ],
    [
      "event",
      { kind: "event" as const, name: "Triage", source: "GitHub" },
      eventRequest("e1", "s1"),
    ],
  ])(
    "a %s automation may stay quiet, with the note inside its message tag",
    (_, origin, requestId) => {
      expect(frameInput("Check the inbox", origin, requestId)).toBe(
        `[message ${requestId}]\n${QUIET_NOTE}\nCheck the inbox`,
      );
    },
  );

  test("only a succeeded script notice may stay quiet, with the note before its output", () => {
    const origin = { kind: "script" as const, name: "Backup" };
    const requestId = scriptRequest("s1", "r1");
    const notice = "Backup\n\nStatus: succeeded";

    expect(
      frameInput(notice, origin, requestId, { scriptSucceeded: true }),
    ).toBe(`${QUIET_NOTE}\n${notice}`);
    expect(frameInput(notice, origin, requestId)).toBe(notice);
  });

  test("only automations carry the quiet note", () => {
    for (const [origin, requestId] of [
      [{ kind: "owner" as const }, "0b0e1f2a-5b1c-4a9e-8f00-000000000000"],
      [{ kind: "owner" as const, via: "voice" }, voiceRequest("c1", "u1")],
      [
        { kind: "bot" as const, agentId: "b1", name: "Other" },
        "0b0e1f2a-5b1c-4a9e-8f00-000000000001",
      ],
      [{ kind: "call" as const }, voiceCallRequest("c1", "ended")],
    ] as const)
      expect(
        frameInput("hello", origin, requestId, { scriptSucceeded: true }),
      ).not.toContain(QUIET_NOTE);
  });
});
