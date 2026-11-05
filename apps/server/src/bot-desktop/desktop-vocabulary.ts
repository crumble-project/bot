import { BOT_TOOL } from "../contract/tools";
import type { Agent } from "../shared/domain";

/** The screenshot extension's name; group turns leave it out, since a group's transcript can't show the image. */
export const DESKTOP_SCREENSHOT_EXTENSION = "desktop-screenshot";

/** An owner message a job acts for, verbatim; a job started by an automation counts the automation's text as one. */
export type OwnerMessage = {
  requestId: string;
  text: string;
  from: "owner" | "automation";
};

/** Whether the bot's tools pick a bot desktop, on a server that has the image. */
export const usesDesktop = (agent: Pick<Agent, "tools">) =>
  agent.tools.includes(BOT_TOOL.desktop);
