import { logged } from "../shared/app-errors";
import { noticeRequest, type NoticeKind } from "../shared/request-ids";
import { Context, Effect, Layer, Option, Ref, type Scope } from "effect";

export type NoticeHandler = (
  agentId: string,
  text: string,
  requestId: string,
) => Effect.Effect<void, unknown>;

/**
 * Notices for bots' chats from features the chat itself depends on, such as credentials: the owner of the chats
 * registers the handler, which breaks what would otherwise be a cycle between the layers.
 */
export class BotNotices extends Context.Service<
  BotNotices,
  {
    /** Fails when nothing takes notices yet, or when the handler does. */
    readonly notice: NoticeHandler;
    readonly handle: (
      handler: NoticeHandler,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("crumble/bot-ports/BotNotices") {
  static readonly layer = Layer.effect(
    BotNotices,
    Effect.gen(function* () {
      const current = yield* Ref.make<Option.Option<NoticeHandler>>(
        Option.none(),
      );

      const notice: NoticeHandler = (agentId, text, requestId) =>
        Effect.flatMap(Ref.get(current), (handler) =>
          Option.match(handler, {
            onNone: () =>
              Effect.fail(new Error("No chat takes bot notices yet")),
            onSome: (takes) => takes(agentId, text, requestId),
          }),
        );

      const handle = (handler: NoticeHandler) =>
        Effect.acquireRelease(Ref.set(current, Option.some(handler)), () =>
          Ref.set(current, Option.none()),
        );

      return BotNotices.of({ notice, handle });
    }),
  );
}

export const loggedNotices =
  (notices: BotNotices["Service"], label: string) =>
  (agentId: string, text: string, requestId: string) =>
    notices
      .notice(agentId, text, requestId)
      .pipe(logged(label, agentId, requestId));

export const requestAnswers =
  (notices: BotNotices["Service"], kind: NoticeKind) =>
  (agentId: string, name: string, text: string) =>
    loggedNotices(notices, `${kind} notice failed`)(
      agentId,
      text,
      noticeRequest(kind, name, crypto.randomUUID()),
    );
