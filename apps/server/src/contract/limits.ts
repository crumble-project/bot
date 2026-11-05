import * as attachments from "../shared/attachment-rules";
import * as limits from "../shared/limits";

// Bound by name, not re-exported: `web` may import `contract`, never `shared`.

export const {
  attachmentKind,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
} = attachments;

export const {
  CHART_SERIES_COLORS,
  DEFAULT_SCHEDULE_TIMEOUT_SECONDS,
  MAX_BOT_DESCRIPTION_CHARS,
  MAX_BOT_NAME_CHARS,
  MAX_CRON_CHARS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MEMORY_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_SCHEDULE_COMMAND_CHARS,
  MAX_SCHEDULE_NAME_CHARS,
  MAX_SCHEDULE_TIMEOUT_SECONDS,
  MAX_SKILL_NAME_CHARS,
  MIN_GROUP_MEMBERS,
} = limits;

export const MAX_MCP_SERVER_NAME_CHARS = 100;

export const BOT_SECRET_USE_RETENTION_DAYS = 90;
