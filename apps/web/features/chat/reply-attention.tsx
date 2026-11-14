import { createContext, useContext, useEffect, useRef, useState } from "react";
import { onSessionReset } from "@/lib/session";
import type { ReplyReference } from "@crumble/server/contract/push";
import {
  getChatAttention,
  type ChatAttentionController,
} from "@/lib/chat-attention";

export const AttentionChatContext = createContext<string | null>(null);
let activeChat: string | null = null;
let selection: symbol | null = null;

onSessionReset(() => {
  activeChat = null;
  selection = null;
});

export function selectAttentionChat(key: string | null) {
  const owner = Symbol();

  activeChat = key;
  selection = owner;

  return () => {
    if (selection !== owner) return false;

    activeChat = null;
    selection = null;

    return true;
  };
}

type ReplyAttentionProps = {
  controller?: ChatAttentionController;
  references: readonly ReplyReference[];
  ready: boolean;
  element: Element | null;
};

export function ReplyAttention(props: ReplyAttentionProps) {
  return props.references.length ? <ObservedReplyAttention {...props} /> : null;
}

function ObservedReplyAttention({
  controller,
  references,
  ready,
  element,
}: ReplyAttentionProps) {
  const chat = useContext(AttentionChatContext);
  const [boundController] = useState(() => controller ?? getChatAttention());
  const visible = useRef(false);
  const current = useRef({ controller, references, ready, chat });
  current.current = { controller, references, ready, chat };

  useEffect(() => {
    const report = () => {
      if (
        (!current.current.controller &&
          (!current.current.chat || current.current.chat !== activeChat)) ||
        !visible.current ||
        !current.current.ready ||
        document.visibilityState !== "visible" ||
        !document.hasFocus()
      )
        return;

      for (const reference of current.current.references)
        (current.current.controller ?? boundController).displayed(reference);
    };

    report();
    window.addEventListener("focus", report);
    document.addEventListener("visibilitychange", report);

    return () => {
      window.removeEventListener("focus", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, [controller, references, ready]);

  useEffect(() => {
    visible.current = false;

    if (!element) return;
    let observing = true;

    const observer = new IntersectionObserver((entries) => {
      if (!observing) return;
      visible.current = entries.some(
        (entry) =>
          entry.target === element &&
          entry.isIntersecting &&
          entry.intersectionRatio > 0,
      );

      if (
        (current.current.controller ||
          (current.current.chat && current.current.chat === activeChat)) &&
        visible.current &&
        current.current.ready &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      )
        for (const reference of current.current.references)
          (current.current.controller ?? boundController).displayed(reference);
    });

    observer.observe(element);

    return () => {
      observing = false;
      observer.disconnect();
      visible.current = false;
    };
  }, [element]);

  return null;
}
