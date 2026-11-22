import { EMULATE_MODEL_IDS } from "../apps/server/src/providers/emulate-profile.ts";

export const REPLY_TEXT = "Local reply.";

export const STREAM_TEXT =
  "This reply is streamed locally without live credentials.";

export const TOOL_REPLY_TEXT = "Local tool finished.";
export const ERROR_TEXT = "Scripted local provider error.";

export const EMULATE_SEED = {
  ai: {
    strict: true,
    models: [...EMULATE_MODEL_IDS],
    rules: [
      {
        id: "local-reply",
        match: { model: "local-reply", format: "openai-chat" },
        reply: [{ type: "text", text: REPLY_TEXT }],
      },
      {
        id: "local-stream",
        match: { model: "local-stream", format: "openai-chat" },
        reply: [{ type: "text", text: STREAM_TEXT }],
        timing: { chunkDelayMs: 150 },
      },
      {
        id: "local-tool-call",
        match: {
          model: "local-tool",
          format: "openai-chat",
          hasToolResult: false,
          tool: "history_search",
        },
        reply: [
          {
            type: "tool_call",
            name: "history_search",
            arguments: { query: "local" },
          },
        ],
      },
      {
        id: "local-tool-result",
        match: {
          model: "local-tool",
          format: "openai-chat",
          hasToolResult: true,
        },
        reply: [{ type: "text", text: TOOL_REPLY_TEXT }],
      },
      {
        id: "local-error",
        match: { model: "local-error", format: "openai-chat" },
        error: { status: 400, message: ERROR_TEXT },
      },
      {
        id: "local-stall",
        match: {
          model: "local-stall",
          format: "openai-chat",
          stream: true,
        },
        reply: [{ type: "text", text: STREAM_TEXT }],
        fault: { kind: "stall", afterChunks: 1, stallMs: 30000 },
      },
    ],
  },
};
