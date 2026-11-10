import { describe, expect, test } from "bun:test";
import {
  gatewayRequest,
  voiceCallRequest,
  voiceRequest,
} from "../shared/request-ids";
import { frameInput } from "./input-framing";

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
});
