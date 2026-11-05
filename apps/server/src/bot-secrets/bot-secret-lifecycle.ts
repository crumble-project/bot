import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { Effect, Predicate } from "effect";
import type { z } from "zod";
import { Conflict, InvalidInput, NotFound } from "../shared/errors";
import {
  MAX_CREDENTIAL_HOST_CHARS,
  MAX_CREDENTIAL_HOSTS,
  MAX_CREDENTIAL_NAME_CHARS,
  MAX_REQUEST_REASON_CHARS,
} from "../shared/limits";
import { toolOutput } from "../shared/tool-output";
import { BotSecretRequests } from "./bot-secret-requests";
import { BotSecretUses, type BotSecretUse } from "./bot-secret-uses";
import type { BotSecretKind } from "./schema";

/** What differs between the kinds of a bot's named secrets; the rest of their lifecycle is in `botSecretLifecycle`. */
type LifecycleHooks<Saved> = {
  kind: BotSecretKind;
  /** How messages name the kind, such as Credential. */
  title: string;
  find: (agentId: string, name: string) => Effect.Effect<Saved | undefined>;
  deleteRecord: (agentId: string, name: string) => Effect.Effect<boolean>;
  deleteSecrets: (agentId: string, name: string) => Effect.Effect<void>;
  touch: (agentId: string, name: string, at: string) => Effect.Effect<void>;
};

/** One save: `store` writes the slow secrets, `write` the record under the hosts settled once they are done. */
type SaveSteps<Saved, E> = {
  hosts: string[] | undefined;
  /** Refuses the save, after the hosts are known. */
  check: (
    existing: Saved | undefined,
  ) => Effect.Effect<void, InvalidInput | Conflict>;
  store: Effect.Effect<void, E>;
  write: (hosts: string[]) => Effect.Effect<Saved>;
  /** What the bot is told when the save answers its request. */
  notice: (saved: Saved) => string;
};

type UseOptions = { limit: number; before?: string | undefined };

/** Asking for, saving, deleting, declining, and logging one kind of a bot's named secrets. */
export const botSecretLifecycle = <Saved extends { hosts: string[] }, Detail>(
  hooks: LifecycleHooks<Saved>,
  useDetail: z.ZodType<Detail>,
) =>
  Effect.gen(function* () {
    const { kind, title } = hooks;
    const requests = yield* BotSecretRequests;
    const useLog = yield* BotSecretUses;

    const save = Effect.fnUntraced(function* <E>(
      agentId: string,
      name: string,
      steps: SaveSteps<Saved, E>,
    ) {
      const hosts = Effect.gen(function* () {
        const pending = yield* requests.get(agentId, kind, name);
        const existing = yield* hooks.find(agentId, name);
        const found = steps.hosts ?? existing?.hosts ?? pending?.hosts;

        if (!found)
          return yield* new InvalidInput({ message: "Name at least one host" });

        yield* steps.check(existing);

        return found;
      });

      // Checked first, then read again after the secret's slow save, so a save made meanwhile isn't overwritten.
      yield* hosts;
      yield* steps.store;

      const saved = yield* steps.write(yield* hosts);

      yield* requests.answer(agentId, kind, name, steps.notice(saved));

      return saved;
    });

    const ask = Effect.fnUntraced(function* (
      agentId: string,
      input: {
        name: string;
        hosts: string[];
        reason: string;
        oneTimeCode?: boolean | undefined;
      },
      options: {
        alreadyYours: (existing: Saved) => string;
        /** What a saved one lacks though it covers the hosts, so the request still stands. */
        lacks?: (existing: Saved) => boolean;
      },
    ) {
      const existing = yield* hooks.find(agentId, input.name);

      if (
        existing &&
        input.hosts.every((host) => existing.hosts.includes(host)) &&
        !options.lacks?.(existing)
      )
        return yield* new Conflict({ message: options.alreadyYours(existing) });

      return yield* requests.ask(agentId, kind, input);
    });

    /** Deletes the record, its secrets, and its uses; false when there is none. */
    const forget = Effect.fnUntraced(function* (agentId: string, name: string) {
      if (!(yield* hooks.deleteRecord(agentId, name))) return false;

      yield* hooks.deleteSecrets(agentId, name);
      yield* useLog.forget(agentId, kind, name);

      return true;
    });

    const remove = Effect.fnUntraced(function* (agentId: string, name: string) {
      if (yield* forget(agentId, name)) return;

      // Without a record, deleting declines the bot's request for one.
      if (!(yield* requests.decline(agentId, kind, name)))
        return yield* new NotFound({ message: `${title} not found` });
    });

    const decline = Effect.fnUntraced(function* (
      agentId: string,
      name: string,
    ) {
      if (!(yield* requests.decline(agentId, kind, name)))
        return yield* new Conflict({
          message: `${title} request has already been answered`,
        });
    });

    const uses = Effect.fnUntraced(function* (
      agentId: string,
      name: string,
      options: UseOptions,
    ) {
      if (!(yield* hooks.find(agentId, name)))
        return yield* new NotFound({ message: `${title} not found` });

      const listed = yield* useLog.list(agentId, kind, name, options);

      return listed.map(({ detail, ...use }) => ({
        ...use,
        ...useDetail.parse(detail),
      }));
    });

    const recordUse = (
      agentId: string,
      name: string,
      {
        at,
        host,
        error,
        ...detail
      }: Omit<BotSecretUse, "id" | "detail"> & Detail,
    ) =>
      useLog
        .record(agentId, kind, name, { at, host, error, detail })
        .pipe(Effect.andThen(hooks.touch(agentId, name, at)));

    return {
      requests: (agentId: string) => requests.list(agentId, kind),
      ask,
      save,
      forget,
      remove,
      decline,
      uses,
      recordUse,
    };
  });

/** Why a use can't send a secret's value, as the proxy or the desktop reports it. */
export const useFailure = (
  name: string,
  error: { readonly message: string },
) =>
  Predicate.isTagged(error, "SecretUnavailable")
    ? `${name} could not be read: ${error.message}`
    : error.message;

export const hostsText = (hosts: readonly string[]) => hosts.join(", ");

/** One line per named secret, with its hosts. */
export const hostLines = (
  items: readonly { name: string; hosts: readonly string[] }[],
) => items.map((item) => `- ${item.name}: ${hostsText(item.hosts)}`);

/** What a bot names, for which hosts, and why, when it asks the owner for a secret. */
export const requestParameters = {
  name: Type.String({ minLength: 1, maxLength: MAX_CREDENTIAL_NAME_CHARS }),
  hosts: Type.Array(
    Type.String({ minLength: 1, maxLength: MAX_CREDENTIAL_HOST_CHARS }),
    {
      minItems: 1,
      maxItems: MAX_CREDENTIAL_HOSTS,
    },
  ),
  reason: Type.String({ minLength: 1, maxLength: MAX_REQUEST_REASON_CHARS }),
};

/** A tool that asks the owner for a secret; the bot never sees the value. */
export const secretRequestTool = <
  Parameters extends TSchema,
  Request extends JsonValue,
>(tool: {
  name: string;
  description: string;
  parameters: Parameters;
  request: (args: Static<Parameters>) => Request;
}) =>
  defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // The chat offers the owner the form from this call's own result, so code mode keeps it a direct model tool.
    callers: ["model"],
    replay: "unsafe",
    execute: async (args) => {
      const request = tool.request(args);

      // Clients read the request from the details to offer the owner its form.
      return { ...toolOutput({ request }), details: request };
    },
  });
