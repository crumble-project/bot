export type NoticeKind = "credential" | "login";

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

export const botMessageRequest = (executionId: string, status: string) =>
  `bot-message:${executionId}:${status}`;

export const reviewRequest = (executionId: string) => `review:${executionId}`;

export const groupTurnRequest = (
  groupId: string,
  agentId: string,
  through: number,
) => `group-turn:${groupId}:${agentId}:${through}`;

export const groupPostRequest = (executionId: string) =>
  `group-turn:${executionId}`;

/** The ID a job's turn is reviewed under: it has no execution, so nothing resolves this as one. */
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
  | { kind: "review"; executionId: string }
  | { kind: "group-turn" }
  /** A client's own ID. Job deliveries and reports land here too: they never become executions, so nothing decodes them. */
  | { kind: "other" };

export function askingBot(request: ParsedRequest) {
  switch (request.kind) {
    case "delegate":
      return request.sourceAgentId;
    case "job-question":
      return request.assigneeId;
    default:
      return undefined;
  }
}

/** What a request ID says about its turn. A due time or a task ID may hold colons, so the last field takes the rest. */
export function parseRequestId(requestId: string): ParsedRequest {
  const [prefix, subject, ...rest] = requestId.split(":");
  const detail = rest.join(":");

  if (prefix === "group-turn") return { kind: "group-turn" };

  if (!subject) return { kind: "other" };

  switch (prefix) {
    case "schedule":
      return { kind: "schedule", scheduleId: subject, due: detail };
    case "script":
      return { kind: "script", scheduleId: subject, runId: detail };
    case "event":
      return detail
        ? { kind: "event", eventId: subject, scheduleId: detail }
        : { kind: "other" };
    case "delegate":
      return { kind: "delegate", sourceAgentId: subject, taskId: detail };
    case "job-question":
      return { kind: "job-question", assigneeId: subject, questionId: detail };
    case "credential":
    case "login":
      return { kind: "notice", notice: prefix, name: subject, id: detail };
    case "bot-request":
      return { kind: "bot-request", botRequestId: subject };
    case "gateway":
      return { kind: "gateway", adapterId: subject, id: detail };
    case "review":
      return { kind: "review", executionId: subject };
    default:
      return { kind: "other" };
  }
}
