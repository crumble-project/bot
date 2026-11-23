import { join } from "node:path";
import { isAccountId } from "../shared/account-id";

export const accountsDir = (dataDir: string) => join(dataDir, "users");

export function accountDir(dataDir: string, accountId: string) {
  if (!isAccountId(accountId)) {
    throw new Error("Invalid account ID");
  }

  return join(accountsDir(dataDir), accountId);
}
