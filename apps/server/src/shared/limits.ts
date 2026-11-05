// Contract `maxLength`s and tool schemas read these: a new value is a wire change.

export const MAX_MESSAGE_CHARS = 32000;
export const MAX_MEMORY_CHARS = 32000;
export const MAX_INSTRUCTIONS_CHARS = 32000;
export const MESSAGE_PREVIEW_CHARS = 240;

export const MAX_BOT_NAME_CHARS = 80;
export const MAX_BOT_DESCRIPTION_CHARS = 1000;
export const MAX_PROVIDER_ID_CHARS = 80;
export const MAX_MODEL_ID_CHARS = 200;
export const MAX_TOOL_ID_CHARS = 200;
export const MAX_BOT_TOOLS = 100;
export const MAX_BOT_SKILLS = 100;
export const MAX_BOT_MCP_SERVERS = 30;
export const MAX_REQUEST_REASON_CHARS = 1000;
export const DEFAULT_REVIEW_THRESHOLD = 10;

export const MAX_SCHEDULE_NAME_CHARS = 200;
export const MAX_SCHEDULE_COMMAND_CHARS = 8000;
export const MAX_SCHEDULE_TIMEOUT_SECONDS = 3600;
export const DEFAULT_SCHEDULE_TIMEOUT_SECONDS = 600;
export const DEFAULT_SCHEDULE_TIMEZONE = "UTC";
export const MAX_CRON_CHARS = 100;
export const MAX_TIMEZONE_CHARS = 100;
export const MAX_RUN_AT_CHARS = 40;
export const MAX_EVENT_SOURCE_ID_CHARS = 200;

export const MAX_SKILL_NAME_CHARS = 100;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;
export const MAX_SKILL_DOCUMENT_CHARS = 64000;
export const MAX_SKILL_DOCUMENTS = 20;
export const MAX_SKILL_DOCUMENT_PATH_CHARS = 200;

// Larger files aren't skill instructions.
export const MAX_SKILL_FILE_BYTES = 512 * 1024;

export const MAX_CREDENTIAL_NAME_CHARS = 64;
export const MAX_CREDENTIAL_HOST_CHARS = 253;
export const MAX_CREDENTIAL_HOSTS = 20;
export const MAX_SECRET_CHARS = 16000;

export const MIN_GROUP_MEMBERS = 2;
export const MAX_GROUP_MEMBERS = 6;
export const MAX_GROUP_NAME_CHARS = 80;

/** `text` within `max` characters, its cut marked. */
export const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** Theme colors a chart may use, `series-1` on; native clients read them too. */
export const CHART_SERIES_COLORS = 8;
