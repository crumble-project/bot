/** An account's ID: it names a data directory and leads a viewer ticket, so both must accept the same IDs. */
export const ACCOUNT_ID_PATTERN = "[A-Za-z0-9_-]{1,128}";

export const isAccountId = (id: string) =>
  new RegExp(`^${ACCOUNT_ID_PATTERN}$`).test(id);

const CREDENTIAL = new RegExp(`^(${ACCOUNT_ID_PATTERN})\\.[A-Za-z0-9_-]+$`);

/** The account a `<accountId>.<secret>` credential names, such as a viewer ticket or a voice gateway token. */
export const credentialAccount = (credential: string) =>
  CREDENTIAL.exec(credential)?.[1];
