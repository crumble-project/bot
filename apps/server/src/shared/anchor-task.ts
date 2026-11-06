import { defineTask } from "@earendil-works/pi-durable";

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
