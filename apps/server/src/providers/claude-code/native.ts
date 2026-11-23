export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

export const CRUMBLE_MCP_SERVER = "crumble";

export const CRUMBLE_TOOL_PREFIX = `mcp__${CRUMBLE_MCP_SERVER}__`;

const OFF = new Set(["0", "false", "no", "off"]);

export const isOff = (value: string) => OFF.has(value.toLowerCase());

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
