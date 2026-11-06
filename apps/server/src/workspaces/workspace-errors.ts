import { Schema } from "effect";

export class DesktopNotConfigured extends Schema.TaggedError<DesktopNotConfigured>()(
  "DesktopNotConfigured",
  { message: Schema.String },
) {}

export class DesktopNotEnabled extends Schema.TaggedError<DesktopNotEnabled>()(
  "DesktopNotEnabled",
  { message: Schema.String },
) {}

export class DesktopNotRunning extends Schema.TaggedError<DesktopNotRunning>()(
  "DesktopNotRunning",
  { message: Schema.String },
) {}

export class WorkspaceRemoveFailed extends Schema.TaggedError<WorkspaceRemoveFailed>()(
  "WorkspaceRemoveFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class WorkspaceBootFailed extends Schema.TaggedError<WorkspaceBootFailed>()(
  "WorkspaceBootFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class DesktopStartFailed extends Schema.TaggedError<DesktopStartFailed>()(
  "DesktopStartFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class WorkspaceStreamFailed extends Schema.TaggedError<WorkspaceStreamFailed>()(
  "WorkspaceStreamFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class WorkspaceUnreachable extends Schema.TaggedError<WorkspaceUnreachable>()(
  "WorkspaceUnreachable",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class WorkspacesClosed extends Schema.TaggedError<WorkspacesClosed>()(
  "WorkspacesClosed",
  { message: Schema.String },
) {}

export class WorkspaceSyncFailed extends Schema.TaggedError<WorkspaceSyncFailed>()(
  "WorkspaceSyncFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

/** The bot's machine did not stop cleanly; on Railway it then keeps running for the next boot. */
export class WorkspaceStopFailed extends Schema.TaggedError<WorkspaceStopFailed>()(
  "WorkspaceStopFailed",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type WorkspaceStartError =
  | WorkspaceBootFailed
  | DesktopStartFailed
  | WorkspaceUnreachable
  | WorkspacesClosed
  | WorkspaceStopFailed;

export type DesktopOpenError =
  | DesktopNotConfigured
  | DesktopNotEnabled
  | DesktopNotRunning
  | WorkspaceStreamFailed
  | WorkspaceStartError;
