export type NoticeKind = "credential" | "login" | "files";

export const scheduleRequest = (scheduleId: string, due: string) =>
  `schedule:${scheduleId}:${due}`;

export const scriptRequest = (scheduleId: string, runId: string) =>
  `script:${scheduleId}:${runId}`;

export const eventRequest = (eventId: string, scheduleId: string) =>
  `event:${eventId}:${scheduleId}`;

export const delegationRequest = (sourceAgentId: string, taskId: string) =>
  `delegate:${sourceAgentId}:${taskId}`;

export const jobQuestionRequest = (assigneeId: string, questionId: string) =>
  `job-question:${assigneeId}:${questionId}`;

export const noticeRequest = (kind: NoticeKind, name: string, id: string) =>
  `${kind}:${name}:${id}`;

export const botRequestRequest = (botRequestId: string) =>
  `bot-request:${botRequestId}`;

export const gatewayRequest = (adapterId: string, id: string) =>
  `gateway:${adapterId}:${id}`;

export const voiceRequest = (callId: string, id: string) =>
  `voice:${callId}:${id}`;

export const VOICE_VIA = "voice";

export const voiceCallRequest = (callId: string, phase: "started" | "ended") =>
  `voice-call:${callId}:${phase}`;

export const outsideCallRequest = (callId: string, id: string) =>
  `outside-call:${callId}:${id}`;

export const callRequestRequest = (callRequestId: string) =>
  `call-request:${callRequestId}`;

export const botMessageRequest = (executionId: string, status: string) =>
  `bot-message:${executionId}:${status}`;

export const reviewRequest = (executionId: string) => `review:${executionId}`;

export const jobTurnId = (
  jobKind: string,
  agentId: string,
  conversationId: string,
  submissionId: string,
) => `${jobKind}-job:${agentId}:${conversationId}:${submissionId}`;

export const jobDeliveryRequest = (jobKind: string, taskId: number) =>
  `${jobKind}:${taskId}`;

export const jobReportRequest = (jobKind: string, taskId: number) =>
  `${jobKind}-report:${taskId}`;

export type ParsedRequest =
  | { kind: "schedule"; scheduleId: string; due: string }
  | { kind: "script"; scheduleId: string; runId: string }
  | { kind: "event"; eventId: string; scheduleId: string }
  | { kind: "delegate"; sourceAgentId: string; taskId: string }
  | { kind: "job-question"; assigneeId: string; questionId: string }
  | { kind: "notice"; notice: NoticeKind; name: string; id: string }
  | { kind: "bot-request"; botRequestId: string }
  | { kind: "gateway"; adapterId: string; id: string }
  | { kind: "voice"; callId: string; id: string }
  | { kind: "voice-call"; callId: string }
  | { kind: "outside-call"; callId: string; id: string }
  | { kind: "call-request"; callRequestId: string }
  | { kind: "review"; executionId: string }
  | { kind: "other" };

export function askingBot(request: ParsedRequest) {
  if (request.kind === "delegate") {
    return request.sourceAgentId;
  }

  if (request.kind === "job-question") {
    return request.assigneeId;
  }

  return;
}

type PrefixParser = (subject: string, detail: string) => ParsedRequest;

const noticeOf =
  (notice: NoticeKind): PrefixParser =>
  (name, id) => ({
    kind: "notice",
    notice,
    name,
    id,
  });

const PREFIXES = new Map<string, PrefixParser>([
  ["schedule", (scheduleId, due) => ({ kind: "schedule", scheduleId, due })],
  ["script", (scheduleId, runId) => ({ kind: "script", scheduleId, runId })],
  [
    "event",
    (eventId, scheduleId) =>
      scheduleId ? { kind: "event", eventId, scheduleId } : { kind: "other" },
  ],
  [
    "delegate",
    (sourceAgentId, taskId) => ({ kind: "delegate", sourceAgentId, taskId }),
  ],
  [
    "job-question",
    (assigneeId, questionId) => ({
      kind: "job-question",
      assigneeId,
      questionId,
    }),
  ],
  ["files", noticeOf("files")],
  ["credential", noticeOf("credential")],
  ["login", noticeOf("login")],
  ["bot-request", (botRequestId) => ({ kind: "bot-request", botRequestId })],
  ["gateway", (adapterId, id) => ({ kind: "gateway", adapterId, id })],
  ["voice", (callId, id) => ({ kind: "voice", callId, id })],
  ["voice-call", (callId) => ({ kind: "voice-call", callId })],
  ["outside-call", (callId, id) => ({ kind: "outside-call", callId, id })],
  [
    "call-request",
    (callRequestId) => ({ kind: "call-request", callRequestId }),
  ],
  ["review", (executionId) => ({ kind: "review", executionId })],
]);

export function parseRequestId(requestId: string): ParsedRequest {
  const [prefix, subject, ...rest] = requestId.split(":");
  const detail = rest.join(":");

  if (!subject || !prefix) {
    return { kind: "other" };
  }

  return PREFIXES.get(prefix)?.(subject, detail) ?? { kind: "other" };
}
