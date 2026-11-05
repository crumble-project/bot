import { IconLogin2 } from "@tabler/icons-react";
import {
  SecretRequestCard,
  SecretRequestPending,
} from "@/features/bot-secrets/secret-request";
import type { Message } from "@/features/chat/api";
import { toolDetailsOf } from "@/features/chat/tool-details";
import { toolResult } from "@/features/chat/tool-result";
import { ownerRequestDetails } from "@crumble/server/contract/tool-details";
import { REQUEST_LOGIN_TOOL_NAME } from "@crumble/server/contract/tools";
import { type Logins, loginPath, loginsQuery, refreshLogins } from "./api";
import { LoginSheet } from "./login-sheet";

const requestOf = (message: Message) =>
  toolDetailsOf(message, ownerRequestDetails, REQUEST_LOGIN_TOOL_NAME);

const requestsOf = (data: Logins) => data.requests;

const loginsOf = (data: Logins) => data.logins;

export const loginRequestResult = toolResult(
  requestOf,
  ({ result, chat: { botId } }) => (
    <SecretRequestCard
      icon={IconLogin2}
      asked={result}
      query={loginsQuery(botId)}
      requestsOf={requestsOf}
      savedOf={loginsOf}
    >
      {(request) => (
        <SecretRequestPending
          icon={IconLogin2}
          request={request}
          botId={botId}
          pathOf={loginPath}
          refresh={refreshLogins}
          addLabel="Add login"
        >
          {(onClose) => (
            <LoginSheet
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
