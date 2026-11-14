import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

type AttentionState = {
  controller: ChatAttentionController | undefined;
  references: readonly ReplyReference[];
  ready: boolean;
  chat: string | null;
};

const canReport = (state: AttentionState, visible: boolean) =>
  (state.controller !== undefined ||
    (!!state.chat && state.chat === activeChat)) &&
  visible &&
  state.ready &&
  document.visibilityState === "visible" &&
  document.hasFocus();

function reportDisplayed(
  state: AttentionState,
  visible: boolean,
  fallback: ChatAttentionController,
) {
  if (!canReport(state, visible)) return;

  for (const reference of state.references)
    (state.controller ?? fallback).displayed(reference);
}

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

  const current = useRef<AttentionState>({
    controller,
    references,
    ready,
    chat,
  });

  useLayoutEffect(() => {
    current.current = { controller, references, ready, chat };
  });

  useEffect(() => {
    const report = () =>
      reportDisplayed(current.current, visible.current, boundController);

    report();
    window.addEventListener("focus", report);
    document.addEventListener("visibilitychange", report);

    return () => {
      window.removeEventListener("focus", report);
      document.removeEventListener("visibilitychange", report);
    };
  }, [boundController, controller, references, ready]);

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

      reportDisplayed(current.current, visible.current, boundController);
    });

    observer.observe(element);

    return () => {
      observing = false;
      observer.disconnect();
      visible.current = false;
    };
  }, [boundController, element]);

  return null;
}
