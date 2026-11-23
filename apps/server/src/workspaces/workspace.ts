import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Effect } from "effect";
import { Context, Layer } from "effect";
import type { Scope } from "effect";
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
  env(agentId: string, shellEnv?: Record<string, string>): ExecutionEnv;
  readonly desktop: boolean;
  restart(agentId: string): Effect.Effect<void, WorkspaceStopFailed>;
  remove(agentId: string): Effect.Effect<void, WorkspaceRemoveFailed>;
  openDesktop(
    agentId: string,
    options?: { passive?: boolean },
  ): Effect.Effect<DesktopStream, DesktopOpenError>;
  running(agentId: string): boolean;
  desktopRunning(agentId: string): boolean;
  startDesktop(agentId: string): Effect.Effect<void, DesktopOpenError>;
  keepAwake(agentId: string): () => void;
  outdated(): Array<string>;
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
