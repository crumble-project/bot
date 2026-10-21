# Desktop jobs, milestone 3 (server part): notifications for job answers — Implementation Plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** The owner is notified of the bot's answer to a coding or desktop job's report, so a desktop job asking for a login reaches them, and clients can open the bot desktop from that notification. Contract 1.6.0. The apfelkern and macOS parts of milestone 3 follow in their repositories, against this release.
**Architecture:** Job reports reach the bot's chat through Pi Durable without an execution, so `CrumbleService.announceReply` never sees the bot's answer to them. The job reporter (`jobs.ts`) waits for that answer and announces it once through its kind's `onAnswer` listeners; the server turns each into a `reply` activity with origin `coding` or `desktop` and the job's name.
**Tech stack:** Bun 1.4, `@earendil-works/pi-durable` 1.3.0, Zod 4.

## Global constraints

- Branch `feat/0002-desktop-jobs-m3` in `bot`; commit after each task.
- Contract `1.6.0`, with a `## Contract 1.6.0` section in `CHANGELOG.md`.
- A reaction or a tool call without text announces nothing, like `announceReply`.
- Deliveries created before this change have no `agentId` in their input and announce nothing.

## Task 1: Announce the bot's answer to job reports

**Files:** `src/jobs.ts` (`JobAnswer`, `ReporterInput.agentId`, the `announce` phase, `onAnswer`), `src/coding.ts` and `src/desktop.ts` (`codingAnswers`, `desktopAnswers`), `src/service.ts` (`announceJobAnswer`, `ReplyActivity.jobName`), `src/api-responses.ts` (`ReplyEvent.jobName`, `origin` description), `src/server.ts` (listeners), `test/desktop.test.ts`, `test/api.test.ts`.

- [ ] Test: a desktop job run with a faux model announces exactly one answer: the bot, kind `desktop`, the job's name, the answer's entry, its text, and an event ID `desktop-report:<reporter task>`.
- [ ] Test: `announceJobAnswer` emits a `reply` activity with origin `desktop`, `jobName`, the entry reference, and the report's event ID as `executionId`; a bot unknown to the store is ignored.
- [ ] Implement: the report phase waits for its submission to settle, reads the answer's text in a commit, and moves to `announce` only when there is text; `announce` calls the listeners, then ends the task.
- [ ] Wire `codingAnswers` and `desktopAnswers` to `service.announceJobAnswer` in `startServer`, and unsubscribe on close.
- [ ] Contract 1.6.0, `bun run openapi:generate`, changelog with the contract section, architecture note.
- [ ] `bun run check`, `bun src/contract-release.ts validate`, and the release bundle export pass.
