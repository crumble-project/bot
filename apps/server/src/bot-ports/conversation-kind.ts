import type { Context } from "@earendil-works/chord/context";
import type {
  ConversationId,
  defineTool,
  DocumentReader,
  Extension,
} from "@earendil-works/pi-durable";
import type { Agent } from "../contract/agents";
import { inChat } from "../shared/chat-only";

export type BotTool = ReturnType<typeof defineTool>;

export type ConversationParts = {
  memory: BotTool[];
  skill: BotTool[];
  skillManage: BotTool;
  vision: BotTool[];
  memoryExtension: Extension;
  skillExtension: Extension;
  visionExtension: Extension;
  offered: Extension[];
};

/** `bare`: the prompt is `standing` and the clock alone, without the identity line, skills, or memory. */
export type ConversationPrompt = {
  standing?: (agent: Agent) => string[];
  addition?: string;
  skillWriting?: boolean;
  bare?: true;
};

export type ConversationStyle = {
  tools: (parts: ConversationParts) => BotTool[];
  extensions?: (parts: ConversationParts) => Extension[];
  prompt?: ConversationPrompt;
  model?: (agent: Agent) => Pick<Agent, "provider" | "model">;
  noEnvironment?: boolean;
};

/** One kind of conversation besides the chat. Built once per bot, as its extension may hold state. */
export type ConversationKind = {
  extension: Extension;
  recognize: (
    reader: DocumentReader,
    conversationId: ConversationId,
    context: Context,
  ) => Promise<ConversationStyle | undefined>;
};

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

export const CHAT_STYLE: ConversationStyle = {
  tools: (parts) => chatTools(parts, parts.offered.filter(inChat)),
};
