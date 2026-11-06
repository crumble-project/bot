import { IconKey } from "@tabler/icons-react";
import { secretRequestResult } from "@/features/bot-secrets/secret-request";
import { REQUEST_CREDENTIAL_TOOL_NAME } from "@crumble/server/contract/tools";
import {
  type Credentials,
  credentialPath,
  credentialsQuery,
  invalidateCredentials,
} from "./api";
import { CredentialSheet } from "./credential-sheet";

export const credentialRequestResult = secretRequestResult({
  tool: REQUEST_CREDENTIAL_TOOL_NAME,
  icon: IconKey,
  query: credentialsQuery,
  requestsOf: (data: Credentials) => data.requests,
  savedOf: (data: Credentials) => data.credentials,
  pathOf: credentialPath,
  refresh: invalidateCredentials,
  addLabel: "Add credential",
  Sheet: CredentialSheet,
});
