import { BOT_TOOL } from "@crumble/server/contract/tools";

export const CAPABILITIES = [
  {
    tool: BOT_TOOL.memory,
    label: "Memory",
    help: "Remembers facts across chats.",
  },
  {
    tool: BOT_TOOL.web,
    label: "Web search",
    help: "Searches the web and reads pages.",
  },
  {
    tool: BOT_TOOL.delegate,
    label: "Message other bots",
    help: "Asks the other bots for help.",
  },
  {
    tool: BOT_TOOL.coding,
    label: "Coding",
    help: "Works in its own workspace and runs coding jobs.",
  },
  {
    tool: BOT_TOOL.desktop,
    label: "Bot desktop",
    help: "Runs desktop jobs on its own desktop.",
  },
  {
    tool: BOT_TOOL.createBots,
    label: "Create bots",
    help: "Asks you to approve new bots.",
  },
] as const;
