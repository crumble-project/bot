import { Context, Effect, Layer, Option, Ref } from "effect";
import type { Scope } from "effect";

export type CallLine = { speaker: "bot" | "callee"; text: string };

export type OutsideCallNote = { callee: string; goal: string } & (
  | { kind: "ended"; transcript: Array<CallLine> }
  | { kind: "objected" }
  | { kind: "missed" }
);

export type CallNoteSource = (
  agentId: string,
  callId: string,
) => Effect.Effect<Option.Option<OutsideCallNote>>;

export class CallNotes extends Context.Service<
  CallNotes,
  {
    readonly note: CallNoteSource;
    readonly provide: (
      source: CallNoteSource,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("crumble/bot-ports/CallNotes") {
  static readonly layer = Layer.effect(
    CallNotes,
    Effect.gen(function* () {
      const current = yield* Ref.make<Option.Option<CallNoteSource>>(
        Option.none(),
      );

      const note: CallNoteSource = (agentId, callId) =>
        Effect.flatMap(Ref.get(current), (source) =>
          Option.match(source, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (provided) => provided(agentId, callId),
          }),
        );

      const provide = (source: CallNoteSource) =>
        Effect.acquireRelease(Ref.set(current, Option.some(source)), () =>
          Ref.set(current, Option.none()),
        );

      return CallNotes.of({ note, provide });
    }),
  );
}
