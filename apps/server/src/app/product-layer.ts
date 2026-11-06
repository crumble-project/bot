import { Layer } from "effect";
import { DesktopControlRepository } from "../bot-desktop/desktop-control-repository";
import { DesktopFillRepository } from "../bot-desktop/desktop-fill-repository";
import { desktopFills } from "../bot-desktop/schema";
import { AgentRepository } from "../bot-store/agent-repository";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { ExecutionRepository } from "../bot-store/execution-repository";
import { AgentCredentialRepository } from "../credentials/agent-credential-repository";
import { SecretRepository } from "../secrets/secret-repository";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { McpServerRepository } from "../integrations/mcp-server-repository";
import { MemoryRepository } from "../memory/memory-repository";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { ProviderCredentialRepository } from "../providers/provider-credential-repository";
import {
  automationEventConsumers,
  EventRunRepository,
} from "../automations/event-run-repository";
import { ScheduleRepository } from "../automations/schedule-repository";
import { ScriptRunRepository } from "../automations/script-run-repository";
import { ChangeReverter } from "../learning/change-reverter";
import { LearnedChangeRepository } from "../learned-changes/learned-change-repository";
import { ReviewRepository } from "../learning/review-repository";
import { agentSkillsLayer, SkillRepository } from "../skills/skill-repository";
import { GitHubSkillReader } from "../skills/github-skills";
import { SkillInstaller } from "../skills/skill-installer";
import { credentialAuthorities } from "../credentials/schema";
import { secrets } from "../secrets/schema";
import { LoginRepository } from "../logins/login-repository";
import { passwordManagers } from "../password-managers/schema";
import { providerCredentials } from "../providers/schema";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { SettingsRepository } from "../shared/settings-repository";
import { GatewayRepository } from "../message-gateway/gateway-repository";
import { EventRepository } from "../event-sources/event-repository";
import { githubAppUsers, githubApps } from "../github-apps/schema";

export const encryptedTables = {
  secrets,
  providerCredentials,
  credentialAuthorities,
  passwordManagers,
  desktopFills,
  githubApps,
  githubAppUsers,
};

export const productLayer = (dataDir: string) => {
  const database = ProductDatabase.layer(dataDir);

  const independent = Layer.mergeAll(
    SecretBox.layer(dataDir, Object.values(encryptedTables)),
    LearnedChangeRepository.layer,
    ReviewRepository.layer,
    McpServerRepository.layer,
    SettingsRepository.layer,
    GatewayRepository.layer,
    EventRepository.layer.pipe(
      Layer.provideMerge(automationEventConsumers),
      Layer.provideMerge(EventRunRepository.layer),
    ),
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
    SkillInstaller.layer.pipe(Layer.provide(GitHubSkillReader.layer)),
    AgentRepository.layer.pipe(Layer.provide(agentSkillsLayer)),
  ).pipe(Layer.provideMerge(onChanges));
};

export type ProductServices = Layer.Success<ReturnType<typeof productLayer>>;
