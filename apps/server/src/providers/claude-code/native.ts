/** The origin Claude Code talks to on its own. */
export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

/** The MCP server that offers Crumble's tools; Claude Code names them after it. */
export const CRUMBLE_MCP_SERVER = "crumble";

export const CRUMBLE_TOOL_PREFIX = `mcp__${CRUMBLE_MCP_SERVER}__`;

const OFF = ["0", "false", "no", "off"];

/** Whether an environment value turns its setting off. */
export const isOff = (value: string) => OFF.includes(value.toLowerCase());

/**
 * Every Claude Code process Crumble starts: no tools of its own, no settings, skills, or MCP servers from the machine,
 * and no session files. A safety flag belongs here, so a process can't go without it.
 */
export const baseCliArgs = (model: string) => [
  "-p",
  "--model",
  model,
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--no-session-persistence",
];
