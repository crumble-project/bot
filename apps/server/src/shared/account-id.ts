export const ACCOUNT_ID_PATTERN = "[A-Za-z0-9_-]{1,128}";

export const isAccountId = (id: string) =>
  new RegExp(`^${ACCOUNT_ID_PATTERN}$`).test(id);

const CREDENTIAL = new RegExp(`^(${ACCOUNT_ID_PATTERN})\\.[A-Za-z0-9_-]+$`);

export const credentialAccount = (credential: string) =>
  CREDENTIAL.exec(credential)?.[1];
