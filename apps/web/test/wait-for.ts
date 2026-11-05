import type { QueryClient } from "@tanstack/react-query";
import { act } from "react";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls inside act so React commits between checks: a fixed wait loses to a loaded machine. */
export async function waitFor(check: () => boolean, expected = "DOM state") {
  const deadline = Date.now() + 4000;

  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${expected}`);
    await act(async () => {
      await pause(5);
    });
  }
}

/** Only before asserting that something did not happen; anything positive uses waitFor. */
export const settle = () =>
  act(async () => {
    await pause(30);
  });

/** Before teardown: a late query notification would reach React after the window is gone. */
export async function waitForIdle(client: QueryClient) {
  await waitFor(
    () => client.isFetching() === 0 && client.isMutating() === 0,
    "requests to finish",
  );
  await settle();
}
