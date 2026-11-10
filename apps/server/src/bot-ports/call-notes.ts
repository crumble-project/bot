import { Context, Effect, Layer, Ref, type Scope } from "effect";

export type CallLine = { speaker: "bot" | "callee"; text: string };

/**
 * What only the model reads about an outside call when its end wakes the bot. `ended` carries the transcript,
 * `objected` none, as the callee objected to the call; `missed`: the call did not reach the callee.
 */
export type OutsideCallNote = { callee: string; goal: string } & (
  | { kind: "ended"; transcript: CallLine[] }
  | { kind: "objected" }
  | { kind: "missed" }
);

export type CallNoteSource = (
  agentId: string,
  callId: string,
) => Effect.Effect<OutsideCallNote | undefined>;

/**
 * Outside calls' notes for the turn their end starts: the voice gateway, which depends on the bot chat, provides the
 * source, so the chat reads the note at admission without depending on it.
 */
export class CallNotes extends Context.Service<
  CallNotes,
  {
    /** Undefined for a call with the owner, and while nothing provides notes. */
    readonly note: CallNoteSource;
    readonly provide: (
      source: CallNoteSource,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("crumble/bot-ports/CallNotes") {
  static readonly layer = Layer.effect(
    CallNotes,
    Effect.gen(function* () {
      const current = yield* Ref.make<CallNoteSource | undefined>(undefined);

      const note: CallNoteSource = (agentId, callId) =>
        Effect.flatMap(Ref.get(current), (source) =>
          source ? source(agentId, callId) : Effect.succeed(undefined),
        );

      const provide = (source: CallNoteSource) =>
        Effect.acquireRelease(Ref.set(current, source), () =>
          Ref.set(current, undefined),
        );

      return CallNotes.of({ note, provide });
    }),
  );
}
