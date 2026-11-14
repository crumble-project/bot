import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventMessage, shownInChat } from "@/features/bot-chat/chat-cards";
import type { Message } from "@/features/chat/api";
import type { CardChat } from "@/features/chat/message-card";
import { isNotice, NoticeRow } from "@/features/chat/transcript";

const chat: CardChat = {
  botId: "bot",
  botName: "Ada",
  attachmentPath: () => "",
  jobStatus: () => {},
  onOpenJob: () => {},
  onOpenCall: () => {},
};

const event = (
  kind: string,
  direction: "inbound" | "outbound",
  content: string,
): Message => ({
  id: "a:1:0",
  entryId: "a:1",
  role: "event",
  kind,
  content,
  replyReferences: [],
  call: { callId: "c1", direction },
});

const text = (markup: string) => markup.replace(/<[^>]+>/gu, " ");

test("a call marker reads Call started, the bot called you with its greeting, or how the call ended", () => {
  const started = renderToStaticMarkup(
    <EventMessage
      message={event("call-started", "inbound", "Call started")}
      chat={chat}
    />,
  );

  const called = renderToStaticMarkup(
    <EventMessage
      message={event("call-started", "outbound", "Dinner is ready.")}
      chat={chat}
    />,
  );

  const ended = renderToStaticMarkup(
    <EventMessage
      message={event(
        "call-ended",
        "inbound",
        "Call ended after 4 minutes: the voice gateway lost its connection.",
      )}
      chat={chat}
    />,
  );

  expect(text(started)).toContain("Call started");
  expect(text(called)).toContain("Ada called you");
  expect(called).toContain("<blockquote");
  expect(text(called)).toContain("Dinner is ready.");
  expect(text(ended)).toContain(
    "Call ended after 4 minutes: the voice gateway lost its connection.",
  );

  for (const markup of [started, called, ended]) {
    expect(markup).toContain("tabler-icon-phone");
    expect(markup).not.toContain("aria-expanded");
  }
});

test("an outside call's start marker is left out of the chat: its card stands for the call", () => {
  const message = event("call-started", "outbound", "Hi, this is Ada.");

  expect(shownInChat(message)).toBe(true);
  expect(
    shownInChat({
      ...message,
      call: { callId: "c1", direction: "outbound", callee: "Trattoria Roma" },
    }),
  ).toBe(false);
});

test("a call notice is drawn as the same marker, with the bot's reaction, not as the owner's message", () => {
  const notice: Message = {
    id: "a:2:0",
    entryId: "a:2",
    role: "user",
    kind: "crumble.message",
    content: "Call ended after 4 minutes.",
    replyReferences: [],
    origin: { kind: "call" },
  };

  const markup = renderToStaticMarkup(
    <NoticeRow message={notice} reactions={[{ emoji: "👍" }]} />,
  );

  expect(isNotice(notice)).toBe(true);
  expect(shownInChat(notice)).toBe(true);
  expect(markup).toContain("tabler-icon-phone");
  expect(text(markup)).toContain("Call ended after 4 minutes.");
  expect(markup).toContain("👍");
  expect(markup).not.toContain("aria-expanded");
});
