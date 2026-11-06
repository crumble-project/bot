import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import { Clock, Context, Effect, Layer, Redacted } from "effect";
import { z } from "zod";
import type { loginUseResponse } from "../contract/api-responses";
import {
  botSecretLifecycle,
  hostLines,
  hostsText,
  requestParameters,
  requestReason,
  secretRequestTool,
  useFailure,
} from "../bot-secrets/bot-secret-lifecycle";
import type { LoginFill, LoginRead } from "./login-fill";
import { accessOf, type Access, type Runner } from "../shared/runner";
import { PasswordManagers } from "../password-managers/password-manager";
import type { SecretUnavailable } from "../secrets/secret-values";
import { Secrets } from "../secrets/secrets";
import {
  loginFieldInput,
  loginName,
  type LoginField,
  type SecretInput,
  type SecretReference,
  credentialHosts,
  loginSaveInput,
} from "../contract/secrets";
import type { BotSecretRequest } from "../bot-secrets/bot-secret-requests";
import type { Login } from "./login-repository";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";
import {
  LoginRepository,
  loginFieldKey,
  loginFieldsPrefix,
  type LoginRecord,
} from "./login-repository";
import { oneTimeCode, parseOneTimeSecret } from "./one-time-codes";
import { REQUEST_LOGIN_TOOL_NAME } from "../contract/tools";

export type LoginSaveInput = z.infer<typeof loginSaveInput>;

export const loginRequestInput = z.object({
  name: loginName,
  hosts: credentialHosts,
  reason: requestReason,
  one_time_code: z.boolean().optional(),
});

export type LoginRequestInput = z.infer<typeof loginRequestInput>;

export type LoginUse = z.infer<typeof loginUseResponse>;

const useDetail = z.object({ field: loginFieldInput });

const ONE_TIME_SECRET =
  "The one-time code needs its secret in base32, or an otpauth://totp/ URI";

type FieldWrite = { field: LoginField; input: SecretInput | null };

export class Logins extends Context.Service<
  Logins,
  {
    readonly list: (agentId: string) => Effect.Effect<Login[]>;
    readonly get: (
      agentId: string,
      name: string,
    ) => Effect.Effect<Login | undefined>;
    readonly requests: (agentId: string) => Effect.Effect<BotSecretRequest[]>;
    readonly request: (
      agentId: string,
      request: LoginRequestInput,
    ) => Effect.Effect<BotSecretRequest, AppError>;
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
      const managers = yield* PasswordManagers;
      const secrets = yield* Secrets;

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

      const lifecycle = yield* botSecretLifecycle(
        {
          kind: "login",
          title: "Login",
          names: loginName,
          find: get,
          deleteRecord: repository.delete,
          deleteSecrets: (agentId, name) =>
            secrets.deleteAll(loginFieldsPrefix(agentId, name)),
          touch: repository.touch,
        },
        useDetail,
      );

      const verifyField =
        (field: LoginField, input: SecretInput) => (value: Redacted.Redacted) =>
          field === "one_time_code" &&
          !(input.reference && secrets.isVolatile(input.reference)) &&
          !parseOneTimeSecret(Redacted.value(value))
            ? Effect.fail(new InvalidInput({ message: ONE_TIME_SECRET }))
            : Effect.void;

      const itemWrites = Effect.fnUntraced(function* (item: SecretReference) {
        const { passwordManager } = item;
        const fields = managers.itemFields(passwordManager, item.reference);

        const reference = (field: LoginField) => ({
          reference: { passwordManager, reference: fields[field] },
        });

        // Only a confirmed missing field means no code; any other failure must not drop a saved one.
        const hasCode = yield* secrets.probe(
          reference("one_time_code").reference,
        );

        return [
          { field: "username", input: reference("username") },
          { field: "password", input: reference("password") },
          {
            field: "one_time_code",
            input: hasCode ? reference("one_time_code") : null,
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

      const save = Effect.fn("Logins.save")(function* (
        agentId: string,
        name: string,
        input: LoginSaveInput,
      ) {
        const checked = yield* lifecycle.checkedName(name);
        const writes = yield* fieldWrites(input);

        return yield* lifecycle.save(agentId, checked, {
          hosts: input.hosts,
          check: (existing) => checkComplete(existing, writes),
          store: Effect.gen(function* () {
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
          }),
          write: (hosts) =>
            Effect.flatMap(repository.save(agentId, checked, hosts), (record) =>
              withFields(agentId, record),
            ),
          notice: (login) =>
            `The owner saved login ${login.name} for ${hostsText(login.hosts)}. Desktop jobs can fill it with fill_login.`,
        });
      });

      const request = Effect.fn("Logins.request")(function* (
        agentId: string,
        input: LoginRequestInput,
      ) {
        return yield* lifecycle.ask(
          agentId,
          { ...input, oneTimeCode: input.one_time_code },
          {
            alreadyYours: (existing) =>
              `Login ${input.name} is already yours for ${hostsText(existing.hosts)}`,
            lacks: (existing) =>
              input.one_time_code === true && !existing.fields.one_time_code,
          },
        );
      });

      const value = Effect.fn("Logins.value")(function* (
        agentId: string,
        name: string,
        field: LoginField,
      ) {
        const key = loginFieldKey(agentId, name, field);
        const computed = secrets.isVolatile(yield* secrets.status(key));
        const read = yield* secrets.read(key);

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

      return Logins.of({
        list: (agentId) =>
          Effect.flatMap(repository.list(agentId), (records) =>
            Effect.forEach(records, (record) => withFields(agentId, record)),
          ),
        get,
        requests: lifecycle.requests,
        request,
        decline: lifecycle.decline,
        save,
        delete: lifecycle.remove,
        uses: lifecycle.uses,
        value,
        recordUse: lifecycle.recordUse,
      });
    }),
  );
}

const SYNC_LOGINS = [
  "list",
  "requests",
  "request",
  "get",
  "uses",
  "recordUse",
] as const;

export type LoginsAccess = Omit<
  Access<Logins["Service"], (typeof SYNC_LOGINS)[number]>,
  "value"
> & {
  read(agentId: string, name: string, field: LoginField): Promise<LoginRead>;
};

export function loginsAccess(runtime: Runner<Logins>): LoginsAccess {
  const logins = runtime.runSync(Logins.use(Effect.succeed));

  return {
    ...accessOf(logins, runtime, SYNC_LOGINS),
    read: (agentId, name, field) =>
      runtime.runPromise(
        logins.value(agentId, name, field).pipe(
          Effect.map((value): LoginRead => ({ value: Redacted.value(value) })),
          Effect.catchTag("NotFound", (error) =>
            Effect.succeed<LoginRead>({ missing: error.message }),
          ),
          Effect.catch((error) =>
            Effect.succeed<LoginRead>({
              unreadable: useFailure(name, error),
            }),
          ),
        ),
      ),
  };
}

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

export function jobLoginSection(logins: readonly Login[]) {
  if (!logins.length) return undefined;

  return [
    "Logins the owner gave this bot, with the hosts each works for:",
    ...hostLines(logins),
    "To sign in, read the sign-in page, then call computer_use with action='fill_login', login, field (username, password, or one_time_code), and the field's ref. You never see the values. If no login covers a sign-in page, stop and say so in your answer, naming the host.",
  ].join("\n");
}

export function loginExtension(agentId: string, logins: LoginsAccess) {
  const request = secretRequestTool({
    name: REQUEST_LOGIN_TOOL_NAME,
    description:
      "Ask the owner for a login your desktop jobs need to sign in to a website, for example when a desktop job reports a sign-in page no login covers. Name it like github or acme-portal, list the hosts it is for (github.com, *.github.com), say why, and set one_time_code when the site asks for a two-factor code. The owner enters it outside the chat; you never see the values. Desktop jobs can then fill it on those hosts. After calling, tell the owner what you asked for and why, then end your turn: a message arrives when the owner answers.",
    parameters: Type.Object({
      ...requestParameters,
      one_time_code: Type.Optional(Type.Boolean()),
    }),
    request: (args) => logins.request(agentId, loginRequestInput.parse(args)),
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
              ? ["Logins your desktop jobs have:", ...hostLines(granted)]
              : []),
            ...(requests.length
              ? [
                  "Logins you asked for that the owner has not answered:",
                  ...hostLines(requests),
                ]
              : []),
          ].join("\n");
        },
      },
    ],
  });
}
