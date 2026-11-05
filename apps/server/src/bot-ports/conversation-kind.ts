import type { Context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  defineTool,
  DocumentReader,
  Extension,
} from "@earendil-works/pi-durable";
import type { Agent } from "../contract/agents";

export type BotTool = ReturnType<typeof defineTool>;

/** What a bot's runtime has for its conversations; each kind picks from it. */
export type ConversationParts = {
  /** The memory tool, while the bot has it. */
  memory: BotTool[];
  /** The skill tool, while the bot has a skill to load. */
  skill: BotTool[];
  skillManage: BotTool;
  /** The image question tool, while the vision model describes images for the bot. */
  vision: BotTool[];
  memoryExtension: Extension;
  skillExtension: Extension;
  visionExtension: Extension;
  /** Every feature's extensions for the bot's chat. */
  offered: Extension[];
};

/** How a kind's instructions differ from the chat's. */
export type ConversationPrompt = {
  /** Replaces the voice guidance, the bot's instructions, and the context guidance. */
  standing?: (agent: Agent) => string[];
  /** Follows the standing parts. */
  addition?: string;
  /** False leaves out the guidance on writing skills. */
  skillWriting?: boolean;
};

/** How the runtime sets up a conversation of one kind. */
export type ConversationStyle = {
  tools: (parts: ConversationParts) => BotTool[];
  /** What it selects; undefined keeps every installed extension but the job knowledge. */
  extensions?: (parts: ConversationParts) => Extension[];
  prompt?: ConversationPrompt;
  /** The model it runs on instead of the bot's. */
  model?: (agent: Agent) => Pick<Agent, "provider" | "model">;
  /** It runs no shell tools, so it gets no environment to reach the workspace through. */
  noEnvironment?: boolean;
};

/** One kind of conversation besides the chat. Built once per bot, as its extension may hold state. */
export type ConversationKind = {
  /** Installed for every bot, whichever conversations select it. */
  extension: Extension;
  /** The conversation's style, or undefined when it isn't of this kind. */
  recognize: (
    reader: DocumentReader,
    conversationId: ConversationId,
    context: Context,
  ) => Promise<ConversationStyle | undefined>;
};

/**
 * A chat's tools in their order: `extensions` take the place of what the chat offers, followed by `own`. The bot can
 * always write its first skill, so management does not wait for the index.
 */
export const chatTools = (
  parts: ConversationParts,
  extensions: Extension[],
  own: BotTool[] = [],
) => [
  ...parts.memory,
  ...parts.skill,
  parts.skillManage,
  ...extensions.flatMap((extension) => extension.tools ?? []),
  ...own,
  ...parts.vision,
];

/** The bot's own chat, which no kind claims. */
export const CHAT_STYLE: ConversationStyle = {
  tools: (parts) => chatTools(parts, parts.offered),
};
