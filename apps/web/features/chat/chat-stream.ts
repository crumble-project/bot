import { useEffect } from "react";
import { follow, queryClient } from "@/lib/api";
import { onSessionReset } from "@/lib/session";
import type { HistoryPage } from "./api";
import type { ConversationTarget } from "./conversation-target";

type Stream = {
  users: number;
  controller: AbortController;
  onGone: (() => void) | null;
  followsAfterView: () => boolean;
};

const streams = new Map<string, Stream>();

function release(key: string) {
  const stream = streams.get(key);

  if (stream && stream.users === 0 && !stream.followsAfterView()) {
    stream.controller.abort();
    streams.delete(key);
  }
}

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated") for (const key of streams.keys()) release(key);
});

onSessionReset(() => {
  for (const stream of streams.values()) stream.controller.abort();
  streams.clear();
});

function followSnapshots<S extends HistoryPage>(
  target: ConversationTarget<S>,
  stream: Stream,
) {
  const { queryKey } = target.query;

  return follow(
    `${target.path}/events`,
    {
      onOpen: () => void queryClient.invalidateQueries({ queryKey }),
      onEvent: (event, data) => {
        if (event === "snapshot")
          queryClient.setQueryData(queryKey, JSON.parse(data));
      },
      onGone: () => {
        void target.refreshList();
        stream.onGone?.();
      },
    },
    stream.controller.signal,
  ).finally(() => {
    if (streams.get(target.key) === stream) streams.delete(target.key);
  });
}

export function useChatStream<S extends HistoryPage>(
  target: ConversationTarget<S>,
  onGone: () => void,
) {
  useEffect(() => {
    let stream = streams.get(target.key);

    if (!stream) {
      const created: Stream = {
        users: 0,
        controller: new AbortController(),
        onGone: null,
        followsAfterView: () => {
          const snapshot = queryClient.getQueryData<S>(target.query.queryKey);

          return snapshot !== undefined && target.followsAfterView(snapshot);
        },
      };

      stream = created;
      streams.set(target.key, created);
      void followSnapshots(target, created);
    }

    stream.users++;
    stream.onGone = onGone;

    return () => {
      stream.users--;
      stream.onGone = null;
      release(target.key);
    };
  }, [target, onGone]);
}
