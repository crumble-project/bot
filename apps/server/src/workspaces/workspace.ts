import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Effect, Layer, type Scope } from "effect";
import type {
  DesktopOpenError,
  WorkspaceStopFailed,
  WorkspaceSyncFailed,
} from "./workspace-errors";

/** A byte stream to the bot desktop's VNC server; closing it releases the machine for its idle stop. */
export type DesktopStream = {
  write(data: Uint8Array): Promise<void>;
  output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

/**
 * Each bot's persistent coding workspace: a disk only that bot and its jobs can reach. The machine behind it starts
 * on first use and may stop when idle; the workspace's files survive both. Closing the layer that made it stops them.
 */
export interface Workspaces {
  /**
   * The bot's environment. Lazy: nothing starts until its first operation. Every command it runs also sees `shellEnv`.
   */
  env(agentId: string, shellEnv?: Record<string, string>): ExecutionEnv;
  /** Whether bots can get a bot desktop: the workspace image for them has one. */
  readonly desktop: boolean;
  /** Stops the bot's machine, whether busy or not; the next operation boots the image the bot needs now. */
  restart(agentId: string): Effect.Effect<void, WorkspaceStopFailed>;
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
  /** Whether the bot's machine runs its bot desktop now. */
  desktopRunning(agentId: string): boolean;
  /** Boots the bot's machine ahead of `openDesktop`, so a viewer about to connect waits less. */
  startDesktop(agentId: string): Effect.Effect<void, DesktopOpenError>;
  /** Keeps the bot's machine from its idle stop until the returned release is called. */
  keepAwake(agentId: string): () => void;
  /** Bots whose running machine has another image than they need now; each switches at its idle stop. */
  outdated(): string[];
  /** Makes completed writes in the bot's workspace durable. A stopped workspace has nothing to flush. */
  sync(agentId: string): Effect.Effect<void, WorkspaceSyncFailed>;
}

/** Workspaces from a backend, which whoever made them stops. */
export type ClosableWorkspaces = Workspaces & {
  close(): Effect.Effect<void, WorkspaceStopFailed>;
};

/** The account's bot workspaces, or none when the server has no workspace backend. */
export class BotWorkspaces extends Context.Service<
  BotWorkspaces,
  Workspaces | undefined
>()("crumble/workspaces/BotWorkspaces") {
  /** The workspaces `acquire` makes; they stop with the layer's scope. */
  static layer(
    acquire: Effect.Effect<Workspaces | undefined, never, Scope.Scope>,
  ) {
    return Layer.effect(BotWorkspaces, acquire);
  }
}
