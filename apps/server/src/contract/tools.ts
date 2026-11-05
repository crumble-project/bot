// Node-free, so the web can name tools without importing the features behind them.

export const CODING_TOOL_NAME = "coding";
export const DESKTOP_TOOL_NAME = "desktop";
export const DESKTOP_SCREENSHOT_TOOL_NAME = "desktop_screenshot";
export const COMPUTER_USE_TOOL_NAME = "computer_use";
export const ASK_OWNER_TOOL_NAME = "ask_owner";
export const REQUEST_CREDENTIAL_TOOL_NAME = "request_credential";
export const REQUEST_LOGIN_TOOL_NAME = "request_login";
export const REQUEST_BOT_TOOL_NAME = "request_bot";
export const REACTION_TOOL_NAME = "react";
export const PASS_TOOL_NAME = "pass";
export const DISPLAY_TOOL_NAME = "show";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_EXTRACT_TOOL_NAME = "web_extract";
export const ASK_ABOUT_IMAGE_TOOL_NAME = "ask_about_image";
export const HISTORY_SEARCH_TOOL_NAME = "history_search";
export const HISTORY_READ_TOOL_NAME = "history_read";
export const MEMORY_TOOL_NAME = "memory";
export const SKILL_TOOL_NAME = "skill";
export const SKILL_MANAGE_TOOL_NAME = "skill_manage";

/** What a bot's saved `tools` list holds: a grant, which may unlock several tool names above. */
export const BOT_TOOL = {
  memory: "memory",
  web: "web",
  delegate: "delegate",
  coding: "coding",
  desktop: "desktop",
  createBots: "create_bots",
  schedule: "schedule",
  codemode: "codemode",
} as const;

/** Tools every bot has, whatever its saved `tools` say. */
export const STANDARD_TOOLS = [BOT_TOOL.schedule, BOT_TOOL.codemode];
