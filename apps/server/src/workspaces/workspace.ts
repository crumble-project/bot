import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Effect, Layer, Schema } from "effect";

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

/** The server has no desktop workspace image configured (`CRUMBLE_WORKSPACE_DESKTOP_IMAGE`). */
export class DesktopNotConfigured extends Schema.TaggedError<DesktopNotConfigured>()(
  "DesktopNotConfigured",
  { message: Schema.String },
) {}

/** The bot's workspace machine runs the plain workspace image without a bot desktop. */
export class PlainWorkspaceImage extends Schema.TaggedError<PlainWorkspaceImage>()(
  "PlainWorkspaceImage",
  {
    agentId: Schema.String,
    image: Schema.String,
    message: Schema.String,
  },
) {}

/** The workspace manager has been closed and cannot start or operate machines. */
export class WorkspacesClosed extends Schema.TaggedError<WorkspacesClosed>()(
  "WorkspacesClosed",
  { message: Schema.String },
) {}

/** The agent ID contains characters that are not allowed in sandbox or volume names. */
export class InvalidAgentId extends Schema.TaggedError<InvalidAgentId>()(
  "InvalidAgentId",
  {
    agentId: Schema.String,
    message: Schema.String,
  },
) {}

/** The workspace backend failed to provision or boot the bot's machine or its host relay. */
export class MachineBootError extends Schema.TaggedError<MachineBootError>()(
  "MachineBootError",
  {
    backend: Schema.String,
    agentId: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Starting the bot desktop inside the guest (`desktop-start.sh`) failed. */
export class DesktopStartError extends Schema.TaggedError<DesktopStartError>()(
  "DesktopStartError",
  {
    agentId: Schema.optionalKey(Schema.String),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Opening a byte stream to a program in the guest (such as `socat` to VNC) failed. */
export class DesktopStreamError extends Schema.TaggedError<DesktopStreamError>()(
  "DesktopStreamError",
  {
    command: Schema.String,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Flushing or stopping a workspace machine failed. */
export class WorkspaceOperationError extends Schema.TaggedError<WorkspaceOperationError>()(
  "WorkspaceOperationError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/** Every failure that can happen while opening or starting a bot desktop. */
export type DesktopOpenError =
  | DesktopNotConfigured
  | PlainWorkspaceImage
  | WorkspacesClosed
  | InvalidAgentId
  | MachineBootError
  | DesktopStartError
  | DesktopStreamError;

/** Every failure a workspace lifecycle operation can produce. */
export type WorkspaceError = DesktopOpenError | WorkspaceOperationError;

/**
 * Each bot's persistent coding workspace: a disk only that bot's coding jobs can reach. The machine behind it starts
 * on first use and may stop when idle; the workspace's files survive both.
 */
export interface Workspaces {
  /**
   * The bot's environment. Lazy: nothing starts until its first operation. Every command it runs also sees `shellEnv`.
   */
  env(agentId: string, shellEnv?: Record<string, string>): ExecutionEnv;
  /** Whether bots can get a bot desktop: the workspace image for them has one. */
  readonly desktop: boolean;
  /** Stops the bot's machine, whether busy or not; the next operation boots the image the bot needs now. */
  restart(agentId: string): Effect.Effect<void, WorkspaceError>;
  /**
   * Connects to the bot desktop's VNC server, booting the machine if needed. The machine stays awake until the stream
   * closes. Fails for a bot without its bot desktop.
   */
  openDesktop(agentId: string): Effect.Effect<DesktopStream, DesktopOpenError>;
  /** Boots the bot's machine ahead of `openDesktop`, so a viewer about to connect waits less. */
  startDesktop(agentId: string): Effect.Effect<void, DesktopOpenError>;
  /** Keeps the bot's machine from its idle stop until the returned release is called. */
  keepAwake(agentId: string): Effect.Effect<() => void, InvalidAgentId>;
  /** Makes completed writes in the bot's workspace durable. A stopped workspace has nothing to flush. */
  sync(agentId: string): Effect.Effect<void, WorkspaceError>;
  /** Flushes and stops every running workspace. */
  readonly close: Effect.Effect<void, WorkspaceError>;
}

/** The account's bot workspaces, or none when the server has no workspace backend. */
export class BotWorkspaces extends Context.Service<
  BotWorkspaces,
  Workspaces | undefined
>()("crumble/workspaces/BotWorkspaces") {
  /** The workspaces `make` returns, closed with the layer's scope. */
  static layer(make: () => Workspaces | undefined) {
    return Layer.effect(
      BotWorkspaces,
      Effect.acquireRelease(Effect.sync(make), (workspaces) =>
        workspaces ? Effect.ignore(workspaces.close) : Effect.void,
      ),
    );
  }
}
