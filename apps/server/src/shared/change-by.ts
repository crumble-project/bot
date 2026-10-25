import type { ChangeBy } from "./domain";

/** Writes without a stated actor come from the owner through the API. */
export const OWNER: ChangeBy = { actor: "owner" };
