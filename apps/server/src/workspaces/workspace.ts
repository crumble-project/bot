import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Effect, Layer, type Scope } from "effect";
import type {
  DesktopOpenError,
  WorkspaceRemoveFailed,
  WorkspaceStopFailed,
  WorkspaceSyncFailed,
} from "./workspace-errors";

export type DesktopStream = {
  write(data: Uint8Array): Promise<void>;
  output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

export interface Workspaces {
  /**
   * The bot's environment. Lazy: nothing starts until its first operation. Every command it runs also sees `shellEnv`.
   */
  env(agentId: string, shellEnv?: Record<string, string>): ExecutionEnv;
  readonly desktop: boolean;
  /** Stops the bot's machine, whether busy or not; the next operation boots the image the bot needs now. */
  restart(agentId: string): Effect.Effect<void, WorkspaceStopFailed>;
  /** Stops the bot's machine and deletes its files for good, for a bot that is being deleted. */
  remove(agentId: string): Effect.Effect<void, WorkspaceRemoveFailed>;
  /**
   * Connects to the bot desktop's VNC server, booting the machine if needed. The machine stays awake until the stream
   * closes. A `passive` stream neither boots nor holds the machine, and ends when it stops.
   */
  openDesktop(
    agentId: string,
    options?: { passive?: boolean },
  ): Effect.Effect<DesktopStream, DesktopOpenError>;
  /** Whether the bot's machine runs now. Cheap and never boots it, unlike every operation of `env`. */
  running(agentId: string): boolean;
  desktopRunning(agentId: string): boolean;
  startDesktop(agentId: string): Effect.Effect<void, DesktopOpenError>;
  keepAwake(agentId: string): () => void;
  /** Bots whose running machine has another image than they need now; each switches at its idle stop. */
  outdated(): string[];
  /** Makes completed writes in the bot's workspace durable. A stopped workspace has nothing to flush. */
  sync(agentId: string): Effect.Effect<void, WorkspaceSyncFailed>;
}

export type ClosableWorkspaces = Workspaces & {
  close(): Effect.Effect<void, WorkspaceStopFailed>;
};

export class BotWorkspaces extends Context.Service<
  BotWorkspaces,
  Workspaces | undefined
>()("crumble/workspaces/BotWorkspaces") {
  static layer(
    acquire: Effect.Effect<Workspaces | undefined, never, Scope.Scope>,
  ) {
    return Layer.effect(BotWorkspaces, acquire);
  }
}
