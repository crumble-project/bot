import { describe, expect, test } from "bun:test";
import {
  botRequestRequest,
  delegationRequest,
  eventRequest,
  gatewayRequest,
  groupPostRequest,
  groupTurnRequest,
  jobDeliveryRequest,
  jobQuestionRequest,
  jobReportRequest,
  noticeRequest,
  parseRequestId,
  type ParsedRequest,
  reviewRequest,
  scheduleRequest,
  scriptRequest,
} from "./request-ids";

const due = "2026-11-05T07:00:00.000Z";

describe("request IDs", () => {
  // These are idempotency keys and stored rows: a changed format starts a run twice.
  test.each([
    [scheduleRequest("s1", due), `schedule:s1:${due}`],
    [scriptRequest("s1", "r1"), "script:s1:r1"],
    [eventRequest("e1", "s1"), "event:e1:s1"],
    [delegationRequest("a1", "t1"), "delegate:a1:t1"],
    [jobQuestionRequest("a1", "q1"), "job-question:a1:q1"],
    [noticeRequest("credential", "TOKEN", "n1"), "credential:TOKEN:n1"],
    [noticeRequest("login", "github", "n1"), "login:github:n1"],
    [botRequestRequest("b1"), "bot-request:b1"],
    [gatewayRequest("discord", "u1"), "gateway:discord:u1"],
    [reviewRequest("x1"), "review:x1"],
    [groupTurnRequest("g1", "a1", 7), "group-turn:g1:a1:7"],
    [groupPostRequest("x1"), "group-turn:x1"],
    [jobDeliveryRequest("coding", 42), "coding:42"],
    [jobReportRequest("desktop", 42), "desktop-report:42"],
  ])("%s keeps its format", (built, stored) => {
    expect(built).toBe(stored);
  });

  test.each([
    [scheduleRequest("s1", due), { kind: "schedule", scheduleId: "s1", due }],
    [
      scriptRequest("s1", "r1"),
      { kind: "script", scheduleId: "s1", runId: "r1" },
    ],
    [
      eventRequest("e1", "s1"),
      { kind: "event", eventId: "e1", scheduleId: "s1" },
    ],
    [
      delegationRequest("a1", "tool:1"),
      { kind: "delegate", sourceAgentId: "a1", taskId: "tool:1" },
    ],
    [
      jobQuestionRequest("a1", "q1"),
      { kind: "job-question", assigneeId: "a1", questionId: "q1" },
    ],
    [
      noticeRequest("credential", "TOKEN", "n1"),
      { kind: "notice", notice: "credential", name: "TOKEN", id: "n1" },
    ],
    [
      noticeRequest("login", "github", "n1"),
      { kind: "notice", notice: "login", name: "github", id: "n1" },
    ],
    [botRequestRequest("b1"), { kind: "bot-request", botRequestId: "b1" }],
    [
      gatewayRequest("discord", "u1"),
      { kind: "gateway", adapterId: "discord", id: "u1" },
    ],
    [reviewRequest("x1"), { kind: "review", executionId: "x1" }],
    [groupTurnRequest("g1", "a1", 7), { kind: "group-turn" }],
    [groupPostRequest("x1"), { kind: "group-turn" }],
    [jobDeliveryRequest("coding", 42), { kind: "other" }],
    [jobReportRequest("desktop", 42), { kind: "other" }],
    ["0b0e1f2a-5b1c-4a9e-8f00-000000000000", { kind: "other" }],
    ["delegate:", { kind: "other" }],
    ["event:e1", { kind: "other" }],
  ] satisfies [string, ParsedRequest][])("%s parses", (requestId, parsed) => {
    expect(parseRequestId(requestId)).toEqual(parsed);
  });
});
