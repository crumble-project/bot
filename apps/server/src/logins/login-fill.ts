import type { LoginField } from "../contract/secrets";

/** What `fill_login` may know about a login: its name, hosts, and which fields it has; never a value. */
export type LoginSummary = {
  name: string;
  hosts: string[];
  fields: LoginField[];
};

/** A field's value for one fill, or why it can't be read. */
export type LoginRead =
  | { value: string }
  /** The login or field doesn't exist; nothing was read. */
  | { missing: string }
  /** Reading failed, such as an unreachable password manager. */
  | { unreadable: string };

/** The bot's logins, as the computer_use tool reaches them; values only through `read`. */
export type LoginFill = {
  list(): Promise<LoginSummary[]>;
  read(name: string, field: LoginField): Promise<LoginRead>;
  recordUse(
    name: string,
    use: { at: string; host: string; field: LoginField; error: string | null },
  ): Promise<void>;
};
