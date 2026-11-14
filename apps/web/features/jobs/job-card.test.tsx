import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JOB_FAILURE_EVENT } from "@crumble/server/contract/tools";
import type { Message } from "@/features/chat/api";
import type { CardChat } from "@/features/chat/message-card";
import { jobFailureEvent } from "./job-card";

const failure: Message = {
  id: "a:1:0",
  entryId: "a:1",
  role: "event",
  kind: JOB_FAILURE_EVENT,
  content: "coding job builder failed: The model is down",
  replyReferences: [],
  origin: { kind: "coding", name: "builder" },
};

const chat: CardChat = {
  botId: "bot",
  botName: "Ada",
  attachmentPath: () => "",
  jobStatus: () => {},
  onOpenJob: () => {},
  onOpenCall: () => {},
};

test("a failed job's event shows its reason", () => {
  const card = jobFailureEvent(failure)!;

  expect(renderToStaticMarkup(card(chat))).toContain(
    "coding job builder failed: The model is down",
  );
});

test("the card is only for a job's failure event", () => {
  expect(jobFailureEvent({ ...failure, kind: "reset" })).toBeNull();
  expect(
    jobFailureEvent({ ...failure, origin: { kind: "bot", name: "Ada" } }),
  ).toBeNull();
});
