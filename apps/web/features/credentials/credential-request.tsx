import { IconKey } from "@tabler/icons-react";
import {
  SecretRequestCard,
  SecretRequestPending,
} from "@/features/bot-secrets/secret-request";
import type { Message } from "@/features/chat/api";
import { toolDetailsOf } from "@/features/chat/tool-details";
import { toolResult } from "@/features/chat/tool-result";
import { ownerRequestDetails } from "@crumble/server/contract/tool-details";
import { REQUEST_CREDENTIAL_TOOL_NAME } from "@crumble/server/contract/tools";
import {
  type Credentials,
  credentialPath,
  credentialsQuery,
  refreshCredentials,
} from "./api";
import { CredentialSheet } from "./credential-sheet";

const requestOf = (message: Message) =>
  toolDetailsOf(message, ownerRequestDetails, REQUEST_CREDENTIAL_TOOL_NAME);

const requestsOf = (data: Credentials) => data.requests;

const credentialsOf = (data: Credentials) => data.credentials;

export const credentialRequestResult = toolResult(
  requestOf,
  ({ result, chat: { botId } }) => (
    <SecretRequestCard
      icon={IconKey}
      asked={result}
      query={credentialsQuery(botId)}
      requestsOf={requestsOf}
      savedOf={credentialsOf}
    >
      {(request) => (
        <SecretRequestPending
          icon={IconKey}
          request={request}
          botId={botId}
          pathOf={credentialPath}
          refresh={refreshCredentials}
          addLabel="Add credential"
        >
          {(onClose) => (
            <CredentialSheet
              bots={[]}
              botId={botId}
              existing={null}
              request={request}
              onClose={onClose}
            />
          )}
        </SecretRequestPending>
      )}
    </SecretRequestCard>
  ),
);
