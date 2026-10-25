import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Cause, Context, Effect, Exit, Layer, Schema } from "effect";

/** The guest path where a bot's workspace lives; coding jobs start here. */
export const WORKSPACE_PATH = "/workspace";

/** The bot's credential proxy authority, installed into the guest's trusted system bundle. */
export const GUEST_CA_PATH =
  "/usr/local/share/ca-certificates/crumble-credentials.crt";

/** Public authorities plus the bot's credential proxy authority. */
export const GUEST_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export class WorkspaceDesktopUnavailable extends Schema.TaggedError<WorkspaceDesktopUnavailable>()(
  "WorkspaceDesktopUnavailable",
  { agentId: Schema.String },
) {}

export class WorkspaceDesktopDisabled extends Schema.TaggedError<WorkspaceDesktopDisabled>()(
  "WorkspaceDesktopDisabled",
  { agentId: Schema.String },
) {}

export class WorkspaceClosed extends Schema.TaggedError<WorkspaceClosed>()(
  "WorkspaceClosed",
  {},
) {}

export class WorkspaceInvalidAgentId extends Schema.TaggedError<WorkspaceInvalidAgentId>()(
  "WorkspaceInvalidAgentId",
  { agentId: Schema.String },
) {}

const failure = {
  agentId: Schema.String,
  backend: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
};

export class WorkspaceBootError extends Schema.TaggedError<WorkspaceBootError>()(
  "WorkspaceBootError",
  failure,
) {}

export class WorkspaceDesktopStartError extends Schema.TaggedError<WorkspaceDesktopStartError>()(
  "WorkspaceDesktopStartError",
  failure,
) {}

export class WorkspaceStreamError extends Schema.TaggedError<WorkspaceStreamError>()(
  "WorkspaceStreamError",
  failure,
) {}

export class WorkspaceSyncError extends Schema.TaggedError<WorkspaceSyncError>()(
  "WorkspaceSyncError",
  failure,
) {}

export class WorkspaceStopError extends Schema.TaggedError<WorkspaceStopError>()(
  "WorkspaceStopError",
  failure,
) {}

export class WorkspaceRelayError extends Schema.TaggedError<WorkspaceRelayError>()(
  "WorkspaceRelayError",
  failure,
) {}

export class WorkspaceSetupError extends Schema.TaggedError<WorkspaceSetupError>()(
  "WorkspaceSetupError",
  failure,
) {}

export class WorkspaceLivenessError extends Schema.TaggedError<WorkspaceLivenessError>()(
  "WorkspaceLivenessError",
  failure,
) {}

export type WorkspaceError =
  | WorkspaceDesktopUnavailable
  | WorkspaceDesktopDisabled
  | WorkspaceClosed
  | WorkspaceInvalidAgentId
  | WorkspaceBootError
  | WorkspaceDesktopStartError
  | WorkspaceStreamError
  | WorkspaceSyncError
  | WorkspaceStopError
  | WorkspaceRelayError
  | WorkspaceSetupError
  | WorkspaceLivenessError;

export const isWorkspaceError = Schema.is(
  Schema.Union([
    WorkspaceDesktopUnavailable,
    WorkspaceDesktopDisabled,
    WorkspaceClosed,
    WorkspaceInvalidAgentId,
    WorkspaceBootError,
    WorkspaceDesktopStartError,
    WorkspaceStreamError,
    WorkspaceSyncError,
    WorkspaceStopError,
    WorkspaceRelayError,
    WorkspaceSetupError,
    WorkspaceLivenessError,
  ]),
);

/** Keeps domain failures intact across SDK Promise boundaries. */
export const workspaceOperation = <A>(
  run: () => Promise<A>,
  failure: (cause: unknown) => WorkspaceError,
) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (isWorkspaceError(cause) ? cause : failure(cause)),
  });

/** External APIs need rejected tagged errors rather than Effect's FiberFailure wrapper. */
export async function workspacePromise<A>(
  effect: Effect.Effect<A, WorkspaceError>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);

  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);

  return exit.value;
}

/** The Promise/iterable boundary used by WebSocket handlers. Rejections retain tagged stream failures. */
export type DesktopStream = {
  write(data: Uint8Array): Promise<void>;
  output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

/** An outbound connection, named by TLS server name or HTTP Host. */
export type WorkspaceRequest = { agentId: string; host: string; port: number };

/** An outbound connection waits for this decision before leaving the guest. */
export type WorkspaceNetworkPolicy = (
  request: WorkspaceRequest,
) => boolean | Promise<boolean>;

export const allowAllRequests: WorkspaceNetworkPolicy = () => true;

/** Each bot's persistent workspace; service methods have no runtime requirements. */
export interface Workspaces {
  /** Lazy: no machine starts until the environment's first operation. */
  env(
    agentId: string,
    shellEnv?: Record<string, string>,
  ): Effect.Effect<ExecutionEnv, WorkspaceError>;
  /** Whether a desktop image is configured, independently of each bot's needs. */
  readonly desktop: boolean;
  /** Stops even a busy machine; its next operation boots the image it needs now. */
  restart(agentId: string): Effect.Effect<void, WorkspaceError>;
  /** Holds the machine awake until the returned VNC stream closes. */
  openDesktop(agentId: string): Effect.Effect<DesktopStream, WorkspaceError>;
  /** Starts the display without waiting for the desktop's browser. */
  startDesktop(agentId: string): Effect.Effect<void, WorkspaceError>;
  /** Prevents idle stops until the returned idempotent release is called. */
  keepAwake(agentId: string): Effect.Effect<() => void, WorkspaceError>;
  /** Makes completed workspace writes durable; stopped workspaces need no flush. */
  sync(agentId: string): Effect.Effect<void, WorkspaceError>;
  /** Flushes and stops every running workspace, attempting all even if one fails. */
  close(): Effect.Effect<void, WorkspaceError>;
}

/** The account's workspaces, or none when no backend is configured. */
export class BotWorkspaces extends Context.Service<
  BotWorkspaces,
  Workspaces | undefined
>()("crumble/workspaces/BotWorkspaces") {
  /** Closes the resource with the layer's scope and logs all cleanup causes. */
  static layer(make: () => Workspaces | undefined) {
    return Layer.effect(
      BotWorkspaces,
      Effect.acquireRelease(Effect.sync(make), (workspaces) =>
        workspaces
          ? workspaces
              .close()
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Workspace cleanup failed", cause),
                ),
              )
          : Effect.void,
      ),
    );
  }
}
