import { Predicate, Schema } from "effect";

/** The server has no desktop workspace image (`CRUMBLE_WORKSPACE_DESKTOP_IMAGE`, or Railway's desktop template is off). */
export class DesktopNotConfigured extends Schema.TaggedError<DesktopNotConfigured>()(
  "DesktopNotConfigured",
  { message: Schema.String },
) {}

/** The bot's machine runs the plain workspace image, because the bot does not have the desktop tool. */
export class DesktopNotEnabled extends Schema.TaggedError<DesktopNotEnabled>()(
  "DesktopNotEnabled",
  { message: Schema.String },
) {}

/** The backend could not start the bot's machine, or set it up before the bot desktop starts. */
export class WorkspaceBootFailed extends Schema.TaggedError<WorkspaceBootFailed>()(
  "WorkspaceBootFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** `desktop-start.sh` failed in the guest: the VNC server or, for jobs, the browser did not come up. */
export class DesktopStartFailed extends Schema.TaggedError<DesktopStartFailed>()(
  "DesktopStartFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** A program stream into the guest did not open, such as the `socat` stream to the bot desktop's VNC server. */
export class WorkspaceStreamFailed extends Schema.TaggedError<WorkspaceStreamFailed>()(
  "WorkspaceStreamFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The backend could not tell whether the bot's machine still runs. */
export class WorkspaceUnreachable extends Schema.TaggedError<WorkspaceUnreachable>()(
  "WorkspaceUnreachable",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The account is closing: its workspaces boot nothing more. */
export class WorkspacesClosed extends Schema.TaggedError<WorkspacesClosed>()(
  "WorkspacesClosed",
  { message: Schema.String },
) {}

/** Completed writes in the bot's workspace could not be made durable. */
export class WorkspaceSyncFailed extends Schema.TaggedError<WorkspaceSyncFailed>()(
  "WorkspaceSyncFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The bot's machine did not stop cleanly; on Railway it then keeps running for the next boot. */
export class WorkspaceStopFailed extends Schema.TaggedError<WorkspaceStopFailed>()(
  "WorkspaceStopFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** Why a workspace's machine did not boot. */
export type WorkspaceStartError =
  | WorkspaceBootFailed
  | DesktopStartFailed
  | WorkspaceUnreachable
  | WorkspacesClosed
  | WorkspaceStopFailed;

/** Why a bot desktop did not open. */
export type DesktopOpenError =
  | DesktopNotConfigured
  | DesktopNotEnabled
  | WorkspaceStreamFailed
  | WorkspaceStartError;

/** The message of a thrown value, for an error that wraps it. */
export const messageOf = (cause: unknown) =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);
