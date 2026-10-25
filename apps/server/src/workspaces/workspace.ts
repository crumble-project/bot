import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Effect, Layer, Predicate, Schema } from "effect";

/** The guest path where a bot's workspace lives; coding jobs start here. */
export const WORKSPACE_PATH = "/workspace";

/** Where the guest keeps the bot's credential proxy authority, which `update-ca-certificates` adds to the bundle. */
export const GUEST_CA_PATH =
  "/usr/local/share/ca-certificates/crumble-credentials.crt";

/** The guest's system bundle: public authorities plus the bot's. */
export const GUEST_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/** A byte stream to the bot desktop's VNC server; closing it releases the machine for its idle stop. */
export type DesktopStream = {
  write(data: Uint8Array): Promise<void>;
  output: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

/** An outbound connection from a bot's workspace, named by its TLS server name or HTTP `Host`. */
export type WorkspaceRequest = { agentId: string; host: string; port: number };

/**
 * Decides a workspace's outbound connections before they leave the machine. A connection waits while the policy does,
 * so an owner-approval flow can replace the default.
 */
export type WorkspaceNetworkPolicy = (
  request: WorkspaceRequest,
) => boolean | Promise<boolean>;

/** Trusts every request to the internet. */
export const allowAllRequests: WorkspaceNetworkPolicy = () => true;

/** The arbitrary value a backend, guest command, or promise rejected with. */
export type FailureCause = Parameters<typeof isWorkspaceFailure>[0];

/** A message for a failure the owner can act on, keeping unrelated secrets out of it. */
const messageOf = (error: FailureCause) =>
  error instanceof Error ? error.message : String(error);

/** The agent id could name another bot's machine or escape its name. */
export class InvalidAgentId extends Schema.TaggedError<InvalidAgentId>()(
  "InvalidAgentId",
  { agentId: Schema.String, message: Schema.String },
) {}

/** The account is shutting down, so it no longer boots or streams machines. */
export class WorkspacesClosed extends Schema.TaggedError<WorkspacesClosed>()(
  "WorkspacesClosed",
  { message: Schema.String },
) {}

/** The backend could not boot the bot's machine, relay, or guest setup. */
export class WorkspaceBootFailed extends Schema.TaggedError<WorkspaceBootFailed>()(
  "WorkspaceBootFailed",
  { agentId: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** The workspace could not make its completed writes durable. */
export class WorkspaceSyncFailed extends Schema.TaggedError<WorkspaceSyncFailed>()(
  "WorkspaceSyncFailed",
  { agentId: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** The bot's machine could not be stopped or torn down. */
export class WorkspaceStopFailed extends Schema.TaggedError<WorkspaceStopFailed>()(
  "WorkspaceStopFailed",
  { agentId: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** The server's workspace configuration cannot boot the machines it was asked for. */
export class WorkspaceConfigFailed extends Schema.TaggedError<WorkspaceConfigFailed>()(
  "WorkspaceConfigFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** No desktop image is configured, so no bot can have a bot desktop. */
export class BotDesktopNotConfigured extends Schema.TaggedError<BotDesktopNotConfigured>()(
  "BotDesktopNotConfigured",
  { agentId: Schema.String, message: Schema.String },
) {}

/** The bot's machine is running the plain workspace image, which has no bot desktop. */
export class BotDesktopImageMissing extends Schema.TaggedError<BotDesktopImageMissing>()(
  "BotDesktopImageMissing",
  { agentId: Schema.String, image: Schema.String, message: Schema.String },
) {}

/** The guest's desktop start script failed. */
export class BotDesktopStartFailed extends Schema.TaggedError<BotDesktopStartFailed>()(
  "BotDesktopStartFailed",
  { agentId: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

/** The VNC stream could not be opened to the bot desktop. */
export class BotDesktopStreamFailed extends Schema.TaggedError<BotDesktopStreamFailed>()(
  "BotDesktopStreamFailed",
  { agentId: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

export type WorkspaceFailure =
  | InvalidAgentId
  | WorkspacesClosed
  | WorkspaceBootFailed
  | WorkspaceSyncFailed
  | WorkspaceStopFailed
  | WorkspaceConfigFailed
  | BotDesktopNotConfigured
  | BotDesktopImageMissing
  | BotDesktopStartFailed
  | BotDesktopStreamFailed;

const workspaceFailureTags = [
  "InvalidAgentId",
  "WorkspacesClosed",
  "WorkspaceBootFailed",
  "WorkspaceSyncFailed",
  "WorkspaceStopFailed",
  "WorkspaceConfigFailed",
  "BotDesktopNotConfigured",
  "BotDesktopImageMissing",
  "BotDesktopStartFailed",
  "BotDesktopStreamFailed",
] as const;

/** Whether a value is one of the failures this module raises. */
export const isWorkspaceFailure = (value: unknown): value is WorkspaceFailure =>
  workspaceFailureTags.some((tag) => Predicate.isTagged(value, tag));

/** A backend failure with its original cause for the log, and a stable message for callers. */
export const workspaceFailure =
  (fallback: (cause: FailureCause) => WorkspaceFailure) =>
  (cause: FailureCause): WorkspaceFailure => {
    if (workspaceFailureTags.some((tag) => Predicate.isTagged(cause, tag))) {
      // SAFETY: the tag list above is exactly WorkspaceFailure's members.
      return cause as WorkspaceFailure;
    }

    return fallback(cause);
  };

/** Builds the message a workspace failure logs or shows without its cause. */
export const failureMessage = (action: string, error: FailureCause) =>
  `${action}: ${messageOf(error)}`;

/** Boots or adopts the workspace; a boot failure names the backend's cause. */
export const bootFailure = (agentId: string) =>
  workspaceFailure(
    (cause) =>
      new WorkspaceBootFailed({
        agentId,
        message: failureMessage("The workspace machine did not start", cause),
        cause,
      }),
  );

/** Starts the guest's bot desktop; a failure keeps the script's output as the cause. */
export const desktopStartFailure = (agentId: string) =>
  workspaceFailure(
    (cause) =>
      new BotDesktopStartFailed({
        agentId,
        message: failureMessage("The bot desktop did not start", cause),
        cause,
      }),
  );

/** Opens the VNC stream; a failure distinguishes the stream from the machine boot. */
export const desktopStreamFailure = (agentId: string) =>
  workspaceFailure(
    (cause) =>
      new BotDesktopStreamFailed({
        agentId,
        message: failureMessage("The bot desktop stream did not open", cause),
        cause,
      }),
  );

/** Syncs the workspace; a failure keeps the guest command's output as the cause. */
export const syncFailure = (agentId: string) =>
  workspaceFailure(
    (cause) =>
      new WorkspaceSyncFailed({
        agentId,
        message: failureMessage("The workspace did not sync", cause),
        cause,
      }),
  );

/** Stops the workspace; a failure keeps the backend's cause. */
export const stopFailure = (agentId: string) =>
  workspaceFailure(
    (cause) =>
      new WorkspaceStopFailed({
        agentId,
        message: failureMessage("The workspace did not stop", cause),
        cause,
      }),
  );

/**
 * Each bot's persistent coding workspace: a disk only that bot's coding jobs can reach. The machine behind it starts
 * on first use and may stop when idle; the workspace's files survive both.
 */
export type WorkspaceService = {
  /** The bot's environment. Lazy: nothing starts until its first operation. Every command it runs also sees `shellEnv`. */
  env(agentId: string, shellEnv?: Record<string, string>): ExecutionEnv;
  /** Whether bots can get a bot desktop: the workspace image for them has one. */
  readonly desktop: boolean;
  /** Stops the bot's machine, whether busy or not; the next operation boots the image the bot needs now. */
  readonly restart: (agentId: string) => Effect.Effect<void, WorkspaceFailure>;
  /**
   * Connects to the bot desktop's VNC server, booting the machine if needed. The machine stays awake until the stream
   * closes. Fails with a tagged reason for a bot without its bot desktop.
   */
  readonly openDesktop: (
    agentId: string,
  ) => Effect.Effect<DesktopStream, WorkspaceFailure>;
  /** Boots the bot's machine ahead of `openDesktop`, so a viewer about to connect waits less. */
  readonly startDesktop: (
    agentId: string,
  ) => Effect.Effect<void, WorkspaceFailure>;
  /** Keeps the bot's machine from its idle stop until the returned release is called. */
  keepAwake(agentId: string): () => void;
  /** Makes completed writes in the bot's workspace durable. A stopped workspace has nothing to flush. */
  readonly sync: (agentId: string) => Effect.Effect<void, WorkspaceFailure>;
  /** Flushes and stops every running workspace. */
  readonly close: Effect.Effect<void, WorkspaceFailure>;
};

/** The account's workspaces, when the server has a workspace backend. */
export class Workspaces extends Context.Service<Workspaces, WorkspaceService>()(
  "crumble/workspaces/Workspaces",
) {
  static layer(make: () => WorkspaceService) {
    return Layer.effect(Workspaces, Effect.sync(make));
  }
}

/** The account's bot workspaces, or none when the server has no workspace backend. */
export class BotWorkspaces extends Context.Service<
  BotWorkspaces,
  WorkspaceService | undefined
>()("crumble/workspaces/BotWorkspaces") {
  /** The workspaces `make` returns, closed with the layer's scope. */
  static layer(make: () => WorkspaceService | undefined) {
    return Layer.effect(
      BotWorkspaces,
      Effect.acquireRelease(Effect.sync(make), (workspaces) =>
        workspaces
          ? workspaces.close.pipe(
              Effect.catchCause((cause) =>
                Effect.logError("Closing bot workspaces failed", cause),
              ),
            )
          : Effect.void,
      ),
    );
  }
}
