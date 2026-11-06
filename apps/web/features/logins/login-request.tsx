import { IconLogin2 } from "@tabler/icons-react";
import { secretRequestResult } from "@/features/bot-secrets/secret-request";
import { REQUEST_LOGIN_TOOL_NAME } from "@crumble/server/contract/tools";
import { type Logins, loginPath, loginsQuery, invalidateLogins } from "./api";
import { LoginSheet } from "./login-sheet";

export const loginRequestResult = secretRequestResult({
  tool: REQUEST_LOGIN_TOOL_NAME,
  icon: IconLogin2,
  query: loginsQuery,
  requestsOf: (data: Logins) => data.requests,
  savedOf: (data: Logins) => data.logins,
  pathOf: loginPath,
  refresh: invalidateLogins,
  addLabel: "Add login",
  Sheet: LoginSheet,
});
