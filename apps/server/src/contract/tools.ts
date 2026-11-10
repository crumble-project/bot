import { JOB_KINDS } from "../shared/job-kinds";
import type { Agent } from "./agents";

// Node-free, so the web can name tools without importing the features behind them.

export const CODING_TOOL_NAME = JOB_KINDS.coding.toolName;
export const DESKTOP_TOOL_NAME = JOB_KINDS.desktop.toolName;
export const DESKTOP_SCREENSHOT_TOOL_NAME = "desktop_screenshot";
export const COMPUTER_USE_TOOL_NAME = "computer_use";
export const ASK_OWNER_TOOL_NAME = "ask_owner";
export const REQUEST_CREDENTIAL_TOOL_NAME = "request_credential";
export const REQUEST_LOGIN_TOOL_NAME = "request_login";
export const REQUEST_BOT_TOOL_NAME = "request_bot";
export const REACTION_TOOL_NAME = "react";
export const CALL_OWNER_TOOL_NAME = "call_owner";
export const HANG_UP_TOOL_NAME = "hang_up";
export const REQUEST_CALL_TOOL_NAME = "request_call";
export const PASS_TOOL_NAME = "pass";
export const DISPLAY_TOOL_NAME = "show";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const WEB_EXTRACT_TOOL_NAME = "web_extract";
export const ASK_ABOUT_IMAGE_TOOL_NAME = "ask_about_image";
export const HISTORY_SEARCH_TOOL_NAME = "history_search";
export const HISTORY_READ_TOOL_NAME = "history_read";
export const MEMORY_TOOL_NAME = "memory";

export const MEMORY_WRITE_ACTIONS = ["create", "update", "delete"] as const;
export const SKILL_TOOL_NAME = "skill";
export const SKILL_MANAGE_TOOL_NAME = "skill_manage";
export const SCHEDULE_TOOL_NAME = "schedule";
export const EVENT_PAYLOAD_TOOL_NAME = "event_payload";

/** Every tool of one MCP server starts with this, which also groups them in code mode. */
export const mcpToolPrefix = (serverId: string) =>
  `mcp_${serverId.replaceAll("-", "").slice(0, 8)}_`;

/** Any MCP server's tool, under this server's prefix or a provider's own `mcp` naming. */
export const isMcpTool = (name: string) => /^(mcp(?:[_:/-]|$))/i.test(name);

export const DEFAULT_JUDGE_MODEL_NAME = "GPT-6 Luna";

/** The `kind` of a transcript event for a job that ended without an answer. */
export const JOB_FAILURE_EVENT = "job-failure";

export const JOB_KIND_NAMES = [CODING_TOOL_NAME, DESKTOP_TOOL_NAME] as const;

export type JobKind = (typeof JOB_KIND_NAMES)[number];

export const isJobKind = (origin: string | undefined): origin is JobKind =>
  JOB_KIND_NAMES.some((kind) => kind === origin);

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

export const usesDesktop = (agent: Pick<Agent, "tools">) =>
  agent.tools.includes(BOT_TOOL.desktop);

export const STANDARD_TOOLS = [BOT_TOOL.schedule, BOT_TOOL.codemode];
