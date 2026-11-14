import type {
  ChatReference,
  ReplyReference,
} from "@crumble/server/contract/push";
import { send } from "@/lib/api";
import { onSessionReset } from "@/lib/session";

export type ChatAttentionController = {
  setChat(chat: ChatReference | null): void;
  displayed(reference: ReplyReference): void;
  dispose(): void;
};

const controllers = new Set<() => void>();
let shared: ChatAttentionController | undefined;

onSessionReset(() => {
  for (const reset of controllers) reset();
  controllers.clear();
  shared = undefined;
});

export function getChatAttention(): ChatAttentionController {
  return (shared ??= createChatAttention());
}

export function createChatAttention(): ChatAttentionController {
  const viewId = crypto.randomUUID();
  let chat: ChatReference | null = null;
  let disposed = false;
  let reset = false;
  let generation = 0;
  let seenGeneration = 0;
  let reportQueue = Promise.resolve();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let reportRetry: ReturnType<typeof setTimeout> | undefined;
  let seenTimer: ReturnType<typeof setTimeout> | undefined;
  let seenSending = false;
  const pending = new Set<string>();

  const failedBatches: {
    chat: ChatReference;
    eventIds: string[];
    generation: number;
  }[] = [];

  const acknowledged = new Set<string>();

  const active = () =>
    !disposed &&
    chat !== null &&
    document.visibilityState === "visible" &&
    document.hasFocus();

  function report(value: ChatReference | null) {
    const current = ++generation;
    clearTimeout(reportRetry);
    reportQueue = reportQueue.then(async () => {
      if (reset || current !== generation) return;

      try {
        await send<"putView">(`/v1/chat-attention/views/${viewId}`, "PUT", {
          chat: value,
        });
      } catch {
        if (!reset && !disposed && current === generation && active())
          reportRetry = setTimeout(() => report(chat), 1000);
      }
    });
  }

  function scheduleSeen(delay: number) {
    if (
      seenTimer !== undefined ||
      seenSending ||
      (pending.size === 0 && failedBatches.length === 0) ||
      disposed
    )
      return;
    seenTimer = setTimeout(() => {
      seenTimer = undefined;
      void flushSeen();
    }, delay);
  }

  async function flushSeen() {
    if (disposed || seenSending) return;

    const batch =
      chat && pending.size > 0
        ? {
            chat,
            eventIds: Array.from(pending).slice(0, 100),
            generation: seenGeneration,
          }
        : failedBatches.shift();

    if (!batch) return;

    if (batch.generation === seenGeneration)
      batch.eventIds.forEach((id) => pending.delete(id));
    seenSending = true;
    let failed = false;

    try {
      await send<"postSeen">("/v1/chat-attention/seen", "POST", {
        chat: batch.chat,
        eventIds: batch.eventIds,
      });

      if (!disposed && batch.generation === seenGeneration)
        batch.eventIds.forEach((id) => acknowledged.add(id));
    } catch {
      failed = true;

      if (!disposed) failedBatches.push(batch);
    } finally {
      seenSending = false;
      scheduleSeen(failed && pending.size === 0 ? 1000 : 0);
    }
  }

  function updateActivity() {
    clearInterval(heartbeat);
    heartbeat = undefined;

    if (active()) {
      report(chat);
      heartbeat = setInterval(() => report(chat), 30_000);
    } else {
      report(null);
    }
  }

  function cleanup(isReset: boolean) {
    if (isReset) reset = true;

    if (!disposed) {
      disposed = true;
      ++seenGeneration;
      pending.clear();
      failedBatches.length = 0;
      clearTimeout(seenTimer);
      clearTimeout(reportRetry);
      clearInterval(heartbeat);
      window.removeEventListener("focus", updateActivity);
      window.removeEventListener("blur", updateActivity);
      document.removeEventListener("visibilitychange", updateActivity);

      if (!isReset) report(null);
    }

    if (isReset) ++generation;

    if (shared === controller) shared = undefined;

    if (isReset) controllers.delete(resetController);
    else void reportQueue.then(() => controllers.delete(resetController));
  }

  const resetController = () => cleanup(true);

  const controller: ChatAttentionController = {
    setChat(next) {
      if (disposed || (chat?.kind === next?.kind && chat?.id === next?.id))
        return;
      ++seenGeneration;
      pending.clear();
      acknowledged.clear();
      clearTimeout(seenTimer);
      seenTimer = undefined;
      chat = next;
      scheduleSeen(1000);
      updateActivity();
    },
    displayed(reference) {
      if (!active() || acknowledged.has(reference.eventId)) return;
      pending.add(reference.eventId);
      scheduleSeen(0);
    },
    dispose() {
      cleanup(false);
    },
  };

  controllers.add(resetController);
  window.addEventListener("focus", updateActivity);
  window.addEventListener("blur", updateActivity);
  document.addEventListener("visibilitychange", updateActivity);

  return controller;
}
