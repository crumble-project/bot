import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Store } from "./store";

export type ControlHolder = "bot" | "owner";

/** Who operates a bot desktop. `changes` counts every change of holder, so a plan from before one can be recognized. */
export type ControlState = {
  holder: ControlHolder;
  changes: number;
  updatedAt: string;
};

type Listener = (state: ControlState) => void;

/** The control lease of each bot desktop: durable in the store, with listeners for live updates. */
export class DesktopControl {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly store: Store) {}

  get(agentId: string): ControlState {
    return (
      this.store.getDesktopControl(agentId) ?? {
        holder: "bot",
        changes: 0,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  set(agentId: string, holder: ControlHolder): ControlState {
    const current = this.get(agentId);

    if (current.holder === holder) return current;

    const next: ControlState = {
      holder,
      changes: current.changes + 1,
      updatedAt: new Date().toISOString(),
    };

    this.store.setDesktopControl(agentId, next);

    for (const listener of this.listeners.get(agentId) ?? []) listener(next);

    return next;
  }

  subscribe(agentId: string, listener: Listener) {
    const set = this.listeners.get(agentId) ?? new Set<Listener>();

    set.add(listener);
    this.listeners.set(agentId, set);

    return () => void set.delete(listener);
  }

  /** Resolves once the bot holds control: at once, or when the owner hands it back. */
  untilBot(agentId: string, context: Context): Promise<ControlState> {
    const current = this.get(agentId);

    if (current.holder === "bot") return Promise.resolve(current);

    let stop = () => {};

    const handedBack = new Promise<ControlState>((resolve) => {
      stop = this.subscribe(agentId, (state) => {
        if (state.holder === "bot") resolve(state);
      });
    });

    return awaitWithContext(handedBack, context).finally(stop);
  }
}
