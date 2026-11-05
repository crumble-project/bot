import type { Message } from "./api";
import { webPagesDetails } from "@crumble/server/contract/tool-details";
import {
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "@crumble/server/contract/tools";
import { type Sources, sourceKey } from "@/lib/sources";
import { toolDetailsOf } from "./tool-details";

function pagesOf(message: Message) {
  const pages = toolDetailsOf(
    message,
    webPagesDetails,
    WEB_SEARCH_TOOL_NAME,
    WEB_EXTRACT_TOOL_NAME,
  );

  return (pages ?? []).flatMap((page) => ("title" in page ? [page] : []));
}

/** A group message's sources, which the server stores with the message. */
export function groupSourcesOf(message: Message): Sources | undefined {
  if (!message.sources?.length) return undefined;

  return new Map(
    message.sources.flatMap(({ url, title }) => {
      const key = sourceKey(url);

      return key ? [[key, title] as const] : [];
    }),
  );
}

/**
 * For each bot reply, the pages its turn searched or read; a turn starts at each message to the bot. A bot chat has no
 * `sources` on the wire, so this reads them here; a group chat's server stores them, for `groupSourcesOf`.
 */
export function sourcesOf(messages: Message[]) {
  const replies = new Map<string, Sources>();
  let turn = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "user") turn = new Map();

    for (const page of pagesOf(message)) {
      const key = sourceKey(page.url);

      if (key) turn.set(key, page.title);
    }

    if (message.role === "assistant" && turn.size > 0)
      replies.set(message.id, new Map(turn));
  }

  return replies;
}
