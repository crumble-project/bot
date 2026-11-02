import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Clock, Context, Effect, Layer, Predicate, Redacted } from "effect";
import { z } from "zod";
import { BotSecretRequests } from "../bot-secrets/bot-secret-requests";
import { BotSecretUses } from "../bot-secrets/bot-secret-uses";
import type { LoginFill, LoginRead } from "../bot-desktop/computer-use-login";
import type { Runner } from "../shared/runner";
import { FIELD_NOT_FOUND } from "../password-managers/one-password";
import {
  SecretValues,
  type SecretUnavailable,
} from "../password-managers/secret-values";
import { Secrets } from "../password-managers/secrets";
import {
  loginFieldInput,
  loginName,
  loginRequestInput,
  type Login,
  type LoginField,
  type LoginRequest,
  type LoginRequestInput,
  type LoginSaveInput,
  type LoginUse,
  type SecretInput,
  type SecretReference,
} from "../shared/domain";
import {
  Conflict,
  InvalidInput,
  NotFound,
  type AppError,
} from "../shared/errors";
import {
  LoginRepository,
  loginFieldKey,
  loginFieldsPrefix,
  type LoginRecord,
} from "./login-repository";
import { oneTimeCode, parseOneTimeSecret } from "./one-time-codes";
import { toolOutput } from "../shared/tool-output";
import { requestParameters } from "../credentials/credentials";

export const REQUEST_LOGIN_TOOL = "request_login";

/** What a login's use records beyond its host: the field filled. */
const useDetail = z.object({ field: loginFieldInput });

// 1Password computes the current code for this attribute; any other one-time code source holds the TOTP secret.
const COMPUTED_CODE = "?attribute=totp";

const ONE_TIME_SECRET =
  "The one-time code needs its secret in base32, or an otpauth://totp/ URI";

/** The field references a 1Password item stands for; its one-time code is used only if the item has one. */
const itemFields = (item: SecretReference) => ({
  username: { ...item, reference: `${item.reference}/username` },
  password: { ...item, reference: `${item.reference}/password` },
  one_time_code: {
    ...item,
    reference: `${item.reference}/one-time password${COMPUTED_CODE}`,
  },
});

const isComputedCode = (reference: string | null) =>
  reference?.endsWith(COMPUTED_CODE) === true;

/** A save's change to one field: a new secret, or null to remove it. */
type FieldWrite = { field: LoginField; input: SecretInput | null };

/**
 * Logins the owner gives a bot for its desktop jobs: a username and password, with an optional one-time code, for
 * named hosts. Values are read only to fill them into a page.
 */
export class Logins extends Context.Service<
  Logins,
  {
    readonly list: (agentId: string) => Effect.Effect<Login[]>;
    readonly get: (
      agentId: string,
      name: string,
    ) => Effect.Effect<Login | undefined>;
    /** The bot's requests for logins the owner has not answered. */
    readonly requests: (agentId: string) => Effect.Effect<LoginRequest[]>;
    readonly request: (
      agentId: string,
      request: LoginRequestInput,
    ) => Effect.Effect<LoginRequest, AppError>;
    readonly decline: (
      agentId: string,
      name: string,
    ) => Effect.Effect<void, AppError>;
    /** Creates or updates a login; saving one the bot asked for answers its request. every reference is read once to check it, and nothing is saved if one fails. */
    readonly save: (
      agentId: string,
      name: string,
      input: LoginSaveInput,
    ) => Effect.Effect<Login, AppError>;
    /** Deletes a login, or declines a request for one. */
    readonly delete: (
      agentId: string,
      name: string,
    ) => Effect.Effect<void, AppError>;
    readonly uses: (
      agentId: string,
      name: string,
      options: { limit: number; before?: string | undefined },
    ) => Effect.Effect<LoginUse[], AppError>;
    /** The value to fill; for a one-time code, the code valid now. */
    readonly value: (
      agentId: string,
      name: string,
      field: LoginField,
    ) => Effect.Effect<
      Redacted.Redacted,
      SecretUnavailable | NotFound | InvalidInput
    >;
    readonly recordUse: (
      agentId: string,
      name: string,
      use: Omit<LoginUse, "id">,
    ) => Effect.Effect<void>;
  }
>()("crumble/logins/Logins") {
  static readonly layer = Layer.effect(
    Logins,
    Effect.gen(function* () {
      const repository = yield* LoginRepository;
      const values = yield* SecretValues;
      const secrets = yield* Secrets;
      const requests = yield* BotSecretRequests;
      const useLog = yield* BotSecretUses;

      const withFields = Effect.fnUntraced(function* (
        agentId: string,
        record: LoginRecord,
      ) {
        const fields: Login["fields"] = {};

        for (const field of loginFieldInput.options) {
          const status = yield* secrets.status(
            loginFieldKey(agentId, record.name, field),
          );

          if (status.configured) fields[field] = status;
        }

        return { ...record, fields } satisfies Login;
      });

      const get = Effect.fn("Logins.get")(function* (
        agentId: string,
        name: string,
      ) {
        const record = yield* repository.get(agentId, name);

        return record && (yield* withFields(agentId, record));
      });

      /** A one-time code's secret must parse, wherever it is read from; a computed code needs no check. */
      const verifyField =
        (field: LoginField, input: SecretInput) => (value: Redacted.Redacted) =>
          field === "one_time_code" &&
          !isComputedCode(input.reference?.reference ?? null) &&
          !parseOneTimeSecret(Redacted.value(value))
            ? Effect.fail(new InvalidInput({ message: ONE_TIME_SECRET }))
            : Effect.void;

      /** The fields an item fills; its one-time code only when the item has one. */
      const itemWrites = Effect.fnUntraced(function* (item: SecretReference) {
        const fields = itemFields(item);

        // Only a confirmed missing field means no code; any other failure must not drop a saved one.
        const hasCode = yield* values.readNow(fields.one_time_code).pipe(
          Effect.as(true),
          Effect.catchTag("SecretUnavailable", (error) =>
            error.reason === FIELD_NOT_FOUND
              ? Effect.succeed(false)
              : Effect.fail(new InvalidInput({ message: error.message })),
          ),
        );

        return [
          { field: "username", input: { reference: fields.username } },
          { field: "password", input: { reference: fields.password } },
          {
            field: "one_time_code",
            input: hasCode ? { reference: fields.one_time_code } : null,
          },
        ] satisfies FieldWrite[];
      });

      const fieldWrites = (input: LoginSaveInput) =>
        input.item
          ? itemWrites(input.item)
          : Effect.succeed(
              loginFieldInput.options.flatMap((field): FieldWrite[] => {
                const source = input.fields?.[field];

                return source === undefined ? [] : [{ field, input: source }];
              }),
            );

      const checkComplete = (
        existing: Login | undefined,
        writes: readonly FieldWrite[],
      ) => {
        const has = (field: "username" | "password") =>
          writes.some((write) => write.field === field) ||
          Boolean(existing?.fields[field]);

        return has("username") && has("password")
          ? Effect.void
          : Effect.fail(
              new InvalidInput({
                message: "A login needs a username and a password",
              }),
            );
      };

      const checkedName = (name: string) => {
        const parsed = loginName.safeParse(name);

        return parsed.success
          ? Effect.succeed(parsed.data)
          : Effect.fail(
              new InvalidInput({
                message:
                  parsed.error.issues[0]?.message ?? "Invalid login name",
              }),
            );
      };

      const save = Effect.fn("Logins.save")(function* (
        agentId: string,
        name: string,
        input: LoginSaveInput,
      ) {
        const checked = yield* checkedName(name);
        const writes = yield* fieldWrites(input);

        const hosts = Effect.gen(function* () {
          const pending = yield* requests.get(agentId, "login", checked);
          const existing = yield* get(agentId, checked);
          const found = input.hosts ?? existing?.hosts ?? pending?.hosts;

          if (!found)
            return yield* new InvalidInput({
              message: "Name at least one host",
            });

          yield* checkComplete(existing, writes);

          return found;
        });

        // Checked first, then read again after the fields' slow save, so a save made meanwhile isn't overwritten.
        yield* hosts;

        yield* secrets.saveAll(
          writes.flatMap(({ field, input: source }) =>
            source
              ? [
                  {
                    key: loginFieldKey(agentId, checked, field),
                    input: source,
                    verify: verifyField(field, source),
                  },
                ]
              : [],
          ),
        );

        for (const { field } of writes.filter((write) => !write.input))
          yield* secrets.delete(loginFieldKey(agentId, checked, field));

        const login = yield* withFields(
          agentId,
          yield* repository.save(agentId, checked, yield* hosts),
        );

        yield* requests.answer(
          agentId,
          "login",
          login.name,
          `The owner saved login ${login.name} for ${login.hosts.join(", ")}. Desktop jobs can fill it with fill_login.`,
        );

        return login;
      });

      const request = Effect.fn("Logins.request")(function* (
        agentId: string,
        input: LoginRequestInput,
      ) {
        const existing = yield* get(agentId, input.name);

        // A login that covers the hosts still answers a request for a one-time code it lacks.
        if (
          existing &&
          input.hosts.every((host) => existing.hosts.includes(host)) &&
          !(input.one_time_code && !existing.fields.one_time_code)
        )
          return yield* new Conflict({
            message: `Login ${input.name} is already yours for ${existing.hosts.join(", ")}`,
          });

        return yield* requests.ask(agentId, "login", {
          ...input,
          oneTimeCode: input.one_time_code,
        });
      });

      const decline = Effect.fn("Logins.decline")(function* (
        agentId: string,
        name: string,
      ) {
        if (!(yield* requests.decline(agentId, "login", name)))
          return yield* new Conflict({
            message: "Login request has already been answered",
          });
      });

      const remove = Effect.fn("Logins.delete")(function* (
        agentId: string,
        name: string,
      ) {
        if (yield* repository.delete(agentId, name)) {
          yield* secrets.deleteAll(loginFieldsPrefix(agentId, name));

          return yield* useLog.forget(agentId, "login", name);
        }

        // Without a login, deleting declines the bot's request for one.
        if (!(yield* requests.decline(agentId, "login", name)))
          return yield* new NotFound({ message: "Login not found" });
      });

      const value = Effect.fn("Logins.value")(function* (
        agentId: string,
        name: string,
        field: LoginField,
      ) {
        const key = loginFieldKey(agentId, name, field);
        // A computed code expires within seconds, so it is never served from the cache.
        const computed = isComputedCode((yield* secrets.status(key)).reference);
        const read = yield* secrets.read(key, { fresh: computed });

        if (!read)
          return yield* new NotFound({
            message: `Login ${name} has no ${field.replaceAll("_", " ")}`,
          });

        if (field !== "one_time_code" || computed) return read;

        const secret = parseOneTimeSecret(Redacted.value(read));

        if (!secret)
          return yield* new InvalidInput({ message: ONE_TIME_SECRET });

        return Redacted.make(
          oneTimeCode(secret, yield* Clock.currentTimeMillis),
        );
      });

      const uses = Effect.fn("Logins.uses")(function* (
        agentId: string,
        name: string,
        options: { limit: number; before?: string | undefined },
      ) {
        if (!(yield* repository.get(agentId, name)))
          return yield* new NotFound({ message: "Login not found" });

        const listed = yield* useLog.list(agentId, "login", name, options);

        return listed.map(({ detail, ...use }): LoginUse => ({
          ...use,
          field: useDetail.parse(detail).field,
        }));
      });

      return Logins.of({
        list: (agentId) =>
          Effect.flatMap(repository.list(agentId), (records) =>
            Effect.forEach(records, (record) => withFields(agentId, record)),
          ),
        get,
        requests: (agentId) => requests.list(agentId, "login"),
        request,
        decline,
        save,
        delete: remove,
        uses,
        value,
        recordUse: (agentId, name, { field, ...use }) =>
          useLog
            .record(agentId, "login", name, { ...use, detail: { field } })
            .pipe(Effect.andThen(repository.touch(agentId, name, use.at))),
      });
    }),
  );
}

/** Logins for code outside Effect: HTTP handlers and the computer_use tool. */
export type LoginsAccess = {
  list(agentId: string): Login[];
  requests(agentId: string): LoginRequest[];
  request(agentId: string, request: LoginRequestInput): LoginRequest;
  decline(agentId: string, name: string): Promise<void>;
  get(agentId: string, name: string): Login | undefined;
  save(agentId: string, name: string, input: LoginSaveInput): Promise<Login>;
  delete(agentId: string, name: string): Promise<void>;
  uses(
    agentId: string,
    name: string,
    options: { limit: number; before?: string | undefined },
  ): LoginUse[];
  read(agentId: string, name: string, field: LoginField): Promise<LoginRead>;
  recordUse(agentId: string, name: string, use: Omit<LoginUse, "id">): void;
};

export function loginsAccess(runtime: Runner<Logins>): LoginsAccess {
  const logins = runtime.runSync(Logins.use(Effect.succeed));

  return {
    list: (agentId) => runtime.runSync(logins.list(agentId)),
    requests: (agentId) => runtime.runSync(logins.requests(agentId)),
    request: (agentId, request) =>
      runtime.runSync(logins.request(agentId, request)),
    decline: (agentId, name) =>
      runtime.runPromise(logins.decline(agentId, name)),
    get: (agentId, name) => runtime.runSync(logins.get(agentId, name)),
    save: (agentId, name, input) =>
      runtime.runPromise(logins.save(agentId, name, input)),
    delete: (agentId, name) => runtime.runPromise(logins.delete(agentId, name)),
    uses: (agentId, name, options) =>
      runtime.runSync(logins.uses(agentId, name, options)),
    read: (agentId, name, field) =>
      runtime.runPromise(
        logins.value(agentId, name, field).pipe(
          Effect.map((value): LoginRead => ({ value: Redacted.value(value) })),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed<LoginRead>({ missing: error.message }),
          ),
          Effect.catch((error) =>
            Effect.succeed<LoginRead>({
              unreadable: Predicate.isTagged(error, "SecretUnavailable")
                ? `${name} could not be read: ${error.message}`
                : error.message,
            }),
          ),
        ),
      ),
    recordUse: (agentId, name, use) =>
      runtime.runSync(logins.recordUse(agentId, name, use)),
  };
}

/** One bot's logins, as its desktop jobs' computer_use tool reaches them. */
export const loginFill = (
  logins: LoginsAccess,
  agentId: string,
): LoginFill => ({
  list: async () =>
    logins.list(agentId).map((login) => ({
      name: login.name,
      hosts: login.hosts,
      fields: loginFieldInput.options.filter((field) => login.fields[field]),
    })),
  read: (name, field) => logins.read(agentId, name, field),
  recordUse: async (name, use) => logins.recordUse(agentId, name, use),
});

const loginLines = (items: readonly { name: string; hosts: string[] }[]) =>
  items.map((item) => `- ${item.name}: ${item.hosts.join(", ")}`);

/** What a desktop job reads about the bot's logins; undefined without any. */
export function jobLoginSection(logins: readonly Login[]) {
  if (!logins.length) return undefined;

  return [
    "Logins the owner gave this bot, with the hosts each works for:",
    ...loginLines(logins),
    "To sign in, read the sign-in page, then call computer_use with action='fill_login', login, field (username, password, or one_time_code), and the field's ref. You never see the values. If no login covers a sign-in page, stop and say so in your answer, naming the host.",
  ].join("\n");
}

/** The bot's `request_login` tool and what it knows about its logins, for bots with desktop jobs. */
export function loginExtension(agentId: string, logins: LoginsAccess) {
  const request = defineTool({
    name: REQUEST_LOGIN_TOOL,
    description:
      "Ask the owner for a login your desktop jobs need to sign in to a website, for example when a desktop job reports a sign-in page no login covers. Name it like github or acme-portal, list the hosts it is for (github.com, *.github.com), say why, and set one_time_code when the site asks for a two-factor code. The owner enters it outside the chat; you never see the values. Desktop jobs can then fill it on those hosts. After calling, tell the owner what you asked for and why, then end your turn: a message arrives when the owner answers.",
    parameters: Type.Object({
      ...requestParameters,
      one_time_code: Type.Optional(Type.Boolean()),
    }),
    // The chat offers the owner the form from this call's own result, so code mode keeps it a direct model tool.
    callers: ["model"],
    replay: "unsafe",
    execute: async (args) => {
      const request = logins.request(agentId, loginRequestInput.parse(args));

      // Clients read the request from the details to offer the owner its form.
      return { ...toolOutput({ request }), details: request };
    },
  });

  return defineExtension({
    name: "logins",
    tools: [request],
    sections: [
      {
        key: "logins",
        render: () => {
          const granted = logins.list(agentId);
          const requests = logins.requests(agentId);

          if (!granted.length && !requests.length) return undefined;

          return [
            ...(granted.length
              ? ["Logins your desktop jobs have:", ...loginLines(granted)]
              : []),
            ...(requests.length
              ? [
                  "Logins you asked for that the owner has not answered:",
                  ...loginLines(requests),
                ]
              : []),
          ].join("\n");
        },
      },
    ],
  });
}
