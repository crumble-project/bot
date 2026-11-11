import { expect, test } from "bun:test";
import { groupMessageInput, messageInput } from "./api-contract";

test("bot and group messages accept file IDs and reject base64 attachments", () => {
  const requestId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  expect(
    messageInput.safeParse({ requestId, content: "", files: [fileId] }).success,
  ).toBe(true);
  expect(
    messageInput.safeParse({ requestId, content: "", files: ["invalid"] })
      .success,
  ).toBe(false);
  expect(
    groupMessageInput.safeParse({ requestId, content: "", files: [fileId] })
      .success,
  ).toBe(true);
  expect(
    groupMessageInput.safeParse({
      requestId,
      content: "",
      attachments: [{ name: "a.txt", mimeType: "text/plain", data: "YQ==" }],
    }).success,
  ).toBe(false);
});
