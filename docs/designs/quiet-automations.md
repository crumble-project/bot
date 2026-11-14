# Quiet automations

**Status:** draft

Taken from Anthropic's article [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents), whose runs may end with nothing sent, and which recommends that an agent start quiet and earn the user's attention.

## Problem

Every scheduled or event automation produces a reply and a push, even when the run found nothing the owner needs. A bot that checks something every hour messages the owner every hour. Nothing tells the bot that silence is a valid outcome of an automation run.

## Solution

The bot's input for an automation run says that it may react instead of replying when the run found nothing the owner needs and the prompt doesn't ask for a message every time. A reaction already ends the turn without a reply notification.

## Behavior

1. A scheduled automation runs, and the bot finds nothing the owner needs. The bot reacts to the automation's message and writes nothing. No reply notification, no push. The transcript shows the automation's message with the reaction.
2. An automation's prompt asks for a message every time, such as a daily summary. The bot replies, as today.
3. An event automation runs, and the event needs nothing from the owner. The bot may react instead of replying, as in 1.
4. A script automation succeeds and its output needs nothing from the owner. The bot may react instead of replying. A script run that failed, timed out, or was interrupted gets no quiet note, and the bot reports it as today.
5. An automation turn that writes nothing and doesn't react still emits a `reply` event with an empty preview, as today.
6. Owner messages, other bots' messages, notices, and calls are framed as today.

## Decisions

- Quiet automation runs reuse the `react` tool and the existing `quiet()` rule in `apps/server/src/bots/bots-announcements.ts`. The wake-up note after a call (`CALL_ENDED_NOTE` in `apps/server/src/bots/input-framing.ts`) already does this. No new tool.
- The note allows quiet only when the prompt doesn't ask for a message each time. A blanket "stay quiet unless something changed" would break automations whose whole purpose is the message.
- `quiet()` doesn't change. A turn without text that didn't react keeps emitting a `reply` event. The note asks for a reaction, which makes the bot's choice to stay quiet visible in the transcript.
- For task and event inputs, the note goes inside the `[message id]` tag that `messageTag` adds, before the prompt, as `SPOKEN_NOTE` does for spoken messages. Script notices carry no tag (`REQUEST_SOURCES` in `apps/server/src/transcript/origins.ts` has none for `script`), so there the note opens the notice. Both put it before any untrusted content: the event payload that `eventRelayText` appends after the prompt, and the command output in a script notice. The note is Crumble's instruction, and the payload and output are data, which anyone the event or the script reads can write.
- The note reaches only the model's copy of the input. The stored message stays the automation's prompt or the notice, as for `CALL_ENDED_NOTE`.
- Script notices get the note only for a succeeded run. A failure must reach the owner. The framing finds the run through the `runId` in the notice's request ID and reads its status from `script_runs`. Parsing the notice's `Status:` line was rejected, because the notice text is display copy, not data.

## Interfaces and data

No API contract, schema, or migration change.

## Affected code

- `apps/server/src/bots/input-framing.ts`: adds the quiet note to the model's copy of task, event, and succeeded script inputs.
- `apps/server/src/bots/bots-admission.ts`: passes a script notice's run status to the framing, as it already passes the event and the call note.
- `apps/server/src/automations/script-run-repository.ts`: adds a read of one run's status by ID.
- `apps/docs/content/concepts/schedules-and-integrations.md` and `apps/docs/content/concepts/event-automations.md`: say that a bot may react instead of replying when an automation run found nothing to report.
- `CHANGELOG.md`: the change.

## Testing

- `apps/server/src/bots/input-framing.test.ts`: task, event, and succeeded script inputs carry the quiet note in the model's copy only, before any payload or output, and inside the message tag where there is one. Failed script notices, owner messages, and bot messages don't carry it.
- A Bots-level test: script notices for runs stored as succeeded, failed, timed out, and interrupted reach the model with the note only for the succeeded run, and the stored messages carry none.
- A Bots-level test: an automation turn whose scripted model reacts gives no `reply` event. Model it on the quiet call wake-up case in `apps/server/src/voice-gateway/voice-gateway.test.ts`.

## Out of scope

- Batching owner messages sent while the bot works. It was split out of this spec: Pi Durable can't batch by input kind, and three reviews found that the workarounds in Crumble (steering, then withdrawing waiting steers) mix inputs, lose attachments after a crash, or resend stopped messages. A later spec starts from there.
- Pacing, digests, or quiet hours for pushes.
- Evals that tune how often bots reply to automations.
- Group chats, which already have `pass`.

## Open questions

None.
