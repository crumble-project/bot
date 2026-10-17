import { createModels } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import { Store } from "../../src/store";
import { AgentRuntime } from "../../src/runtime";
import { CrumbleService } from "../../src/service";

const dir = process.env.BOT_CRASH_DIR;
if (!dir) throw new Error("BOT_CRASH_DIR is required");
const faux = fauxProvider({
  provider: "faux",
  models: [{ id: "crash-model" }],
});
faux.setResponses([fauxAssistantMessage("child response")]);
const models = createModels();
models.setProvider(faux.provider);
const store = new Store(dir);
const agent = store.createAgent(
  {
    name: "Crash",
    avatar: "sparkles",
    description: "",
    instructions: "",
    provider: "faux" as any,
    model: "crash-model",
    enabled: true,
    folder: "Personal",
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  },
  "00000000-0000-4000-8000-000000000301",
);
const runtime = new AgentRuntime(dir, { models });
const service = new CrumbleService(store, runtime);
const conversation = await service.createConversation(
  agent.id,
  "Crash session",
);
const execution = await service.send(
  conversation.id,
  "recover this",
  "00000000-0000-4000-8000-000000000302",
);
process.stdout.write(
  JSON.stringify({
    agentId: agent.id,
    conversationId: conversation.id,
    executionId: execution.id,
  }) + "\n",
);
setInterval(() => {}, 1000);
