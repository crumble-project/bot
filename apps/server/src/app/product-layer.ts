import { Layer } from "effect";
import { DesktopControlRepository } from "../bot-desktop/desktop-control-repository";
import { DesktopFillRepository } from "../bot-desktop/desktop-fill-repository";
import { desktopFills } from "../bot-desktop/schema";
import { AgentRepository } from "../bots/agent-repository";
import { ConversationRepository } from "../bots/conversation-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { AgentCredentialRepository } from "../credentials/agent-credential-repository";
import { SecretRepository } from "../credentials/secret-repository";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { McpServerRepository } from "../integrations/mcp-server-repository";
import { MemoryRepository } from "../memory/memory-repository";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { ProviderCredentialRepository } from "../providers/provider-credential-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { ScriptRunRepository } from "../schedules/script-run-repository";
import { ChangeReverter } from "../skills/change-reverter";
import { InlineSkillsTransfer } from "../skills/inline-skills";
import { LearnedChangeRepository } from "../skills/learned-change-repository";
import { ReviewRepository } from "../skills/review-repository";
import { SkillRepository } from "../skills/skill-repository";
import {
  agentCredentials,
  credentialAuthorities,
  secrets,
} from "../credentials/schema";
import { LoginRepository } from "../logins/login-repository";
import { loginFields } from "../logins/schema";
import { passwordManagers } from "../password-managers/schema";
import { providerCredentials } from "../providers/schema";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { SettingsRepository } from "../shared/settings-repository";
import { GatewayRepository } from "../message-gateway/gateway-repository";

/** Every repository of an account's product database, on one migrated connection. */
export const productLayer = (dataDir: string) => {
  const database = ProductDatabase.layer(dataDir);

  const independent = Layer.mergeAll(
    SecretBox.layer(dataDir, [
      secrets,
      providerCredentials,
      agentCredentials,
      credentialAuthorities,
      passwordManagers,
      loginFields,
      desktopFills,
    ]),
    LearnedChangeRepository.layer,
    ReviewRepository.layer,
    McpServerRepository.layer,
    SettingsRepository.layer,
    GatewayRepository.layer,
    ScheduleRepository.layer,
    ScriptRunRepository.layer,
    DesktopControlRepository.layer,
    ConversationRepository.layer,
    ExecutionRepository.layer,
    GroupChatRepository.layer,
  ).pipe(Layer.provideMerge(database));

  const onChanges = Layer.mergeAll(
    SecretRepository.layer,
    PasswordManagerRepository.layer,
    AgentCredentialRepository.layer,
    LoginRepository.layer,
    DesktopFillRepository.layer,
    SkillRepository.layer,
    MemoryRepository.layer,
  ).pipe(Layer.provideMerge(independent));

  return Layer.mergeAll(
    ProviderCredentialRepository.layer,
    ChangeReverter.layer,
    AgentRepository.layer,
    InlineSkillsTransfer,
  ).pipe(Layer.provideMerge(onChanges));
};

export type ProductServices = Layer.Success<ReturnType<typeof productLayer>>;
