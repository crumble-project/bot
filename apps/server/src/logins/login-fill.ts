import type { LoginField } from "../contract/secrets";

export type LoginSummary = {
  name: string;
  hosts: Array<string>;
  fields: Array<LoginField>;
};

export type LoginRead =
  | { value: string }
  | { missing: string }
  | { unreadable: string };

export type LoginFill = {
  list(): Promise<Array<LoginSummary>>;
  read(name: string, field: LoginField): Promise<LoginRead>;
  recordUse(
    name: string,
    use: { at: string; host: string; field: LoginField; error: string | null },
  ): Promise<void>;
};
