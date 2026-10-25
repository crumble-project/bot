import { defineTask } from "@earendil-works/pi-durable";

/** A background task that only owns a conversation, so the conversation outlives the turns of the chat it came from. */
export const defineAnchorTask = (name: string) =>
  defineTask<null, { phase: "done" }, null>({
    name,
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_anchor, runtime, taskContext) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          taskContext,
        ),
    },
    abort: (_anchor, runtime, taskContext) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        taskContext,
      ),
  });
