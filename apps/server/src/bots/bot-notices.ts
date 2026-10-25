import { Context, Effect, Layer, Ref, type Scope } from "effect";

/** Posts a notice to a bot's chat that starts a turn. */
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
    /** Takes notices with `handler` until the scope closes. */
    readonly handle: (
      handler: NoticeHandler,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("crumble/bots/BotNotices") {
  static readonly layer = Layer.effect(
    BotNotices,
    Effect.gen(function* () {
      const current = yield* Ref.make<NoticeHandler | undefined>(undefined);

      const notice: NoticeHandler = (agentId, text, requestId) =>
        Effect.flatMap(Ref.get(current), (handler) =>
          handler
            ? handler(agentId, text, requestId)
            : Effect.fail(new Error("No chat takes bot notices yet")),
        );

      const handle = (handler: NoticeHandler) =>
        Effect.acquireRelease(Ref.set(current, handler), () =>
          Ref.set(current, undefined),
        );

      return BotNotices.of({ notice, handle });
    }),
  );
}
