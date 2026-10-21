# Desktop jobs, milestone 1: bot desktop and desktop jobs — Implementation Plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** A bot with the `desktop` tool gets a bot desktop in its workspace and can hand work to desktop jobs that operate it through an accessibility tree, mouse, and keyboard, on a model the owner chooses. The owner cannot watch or take control yet; that is milestone 2.
**Architecture:** Each bot keeps one machine, now restarted between boots instead of replaced, so installed programs last until the image changes. The coding job machinery in `coding.ts` becomes a generic job kind (`jobs.ts`) with coding and desktop as two kinds. Workspaces boot a second image with Xvnc, Openbox, tint2, Chromium, and a pinned cua-driver for bots with the `desktop` tool, and start the desktop session from the host at boot. A desktop job has one tool, `computer_use` (ported from Hermes Agent), which calls cua-driver through the job's execution environment. See [feature 0002](https://github.com/crumble-project/spec/blob/main/features/0002-desktop-jobs.md) and the spike in `crumble-project/spikes/microsandbox/den` (`results/den-spike.md`).
**Tech stack:** Bun 1.4, `@earendil-works/pi-durable` 1.3.0, `@earendil-works/pi-ai` 1.3.0, `@earendil-works/pi-env` 1.3.0, Microsandbox 0.7.8, Hono with `@hono/zod-openapi`, Zod 4, Debian trixie, cua-driver-rs 0.38.0.

## Global constraints

- Work on branch `feat/0002-desktop-jobs` in `bot`. Commit only when the owner asks for commits; stage explicit paths only.
- Product language follows the glossary: bot desktop, desktop job, workspace, taking control. Code may say `desktop`.
- Existing coding job data must keep working: the coding kind keeps its document kinds (`crumble.coding-job`, `crumble.coding-jobs`), task names (`crumble.coding-anchor`, `crumble.coding-reporter`), request ID prefixes (`coding:`, `coding-report:`), report frame (`[coding job <name> finished]`), and message origin (`coding`).
- A desktop job has no shell, memory, delegation, scheduling, integrations, or jobs of its own (feature 0002, acceptance criteria).
- One desktop job works on a bot desktop at a time; messages to other desktop jobs of the bot wait (feature 0002, "One desktop job per bot desktop at a time").
- cua-driver telemetry stays off: `CUA_DRIVER_RS_TELEMETRY_ENABLED=0` and `cua-driver telemetry disable` in the image, before any other call.
- No `any`. Type assertions need a `// SAFETY:` comment (lint rule `anti-slop/require-safety-comment-for-type-assertion`).
- Every contract change needs a contract version increase: this milestone moves `1.3.0` to `1.4.0`.
- Tests fake only true external boundaries: model calls (faux provider) and the guest (a scripted execution environment). VM tests run only with `CRUMBLE_VM_TESTS=1`, locally, never in CI.
- Done means `bun run check` passes (lint, format check, typecheck, OpenAPI drift check, tests), plus the VM tests in Task 8 run locally.

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/jobs.ts` | Create | Generic job kind: marker and job documents, anchor and reporter tasks, the job tool, listing, environment |
| `src/coding.ts` | Modify | The coding kind on top of `jobs.ts`; same exports and behavior |
| `workspace-image/Dockerfile` | Modify | `base` and `desktop` targets |
| `workspace-image/desktop/desktop-start.sh` | Create | Starts Xvnc, D-Bus, AT-SPI, cua-driver, Openbox, tint2, and the Chromium supervisor |
| `workspace-image/desktop/browser.sh` | Create | Keeps Chromium running with its profile in the workspace |
| `.github/workflows/workspace-image.yml` | Create | Builds and pushes both images to GHCR on manual runs and tags |
| `src/workspace-proxy.ts` | Modify | Listen on a given port |
| `src/workspace.ts` | Modify | `Workspaces.desktop` and `Workspaces.restart` |
| `src/microsandbox-workspaces.ts` | Modify | Restart the bot's existing machine; desktop image per bot, desktop session at boot, restart |
| `src/computer-use.ts` | Create | The `computer_use` tool over a narrow shell interface |
| `src/desktop.ts` | Create | The desktop job kind and its extensions |
| `src/domain.ts` | Modify | `desktopModel` on agents |
| `src/store.ts` | Modify | `desktop_model` column |
| `src/runtime.ts` | Modify | Desktop job listing and history |
| `src/transcript.ts` | Modify | "Desktop job" chat preview |
| `src/service.ts` | Modify | Desktop job listing and history passthrough |
| `src/api-responses.ts` | Modify | `desktop` capability, `desktopModel`, `DesktopJobs` |
| `src/api-contract.ts` | Modify | Desktop job routes; contract 1.4.0 |
| `src/api.ts` | Modify | Desktop job handlers; restart the workspace when the `desktop` tool changes |
| `src/server.ts` | Modify | Wire desktop jobs, environment, capability |
| `openapi/openapi.json` | Regenerate | Generated contract |
| `test/jobs.test.ts` | Create | Exclusive job kinds wait |
| `test/computer-use.test.ts` | Create | Tool behavior against a scripted guest |
| `test/desktop.test.ts` | Create | Desktop jobs end to end with a faux model and scripted guest |
| `test/desktop-vm.test.ts` | Create | Local VM acceptance tests |
| `test/microsandbox-workspaces.test.ts` | Modify | Machines kept between boots; desktop image selection |
| `test/workspace-proxy.test.ts` | Modify | Proxy on a given port |
| `test/store.test.ts`, `test/api.test.ts` | Modify | `desktopModel`, capability, routes |
| `README.md`, `docs/architecture.md`, `CHANGELOG.md` | Modify | Documentation and contract changelog |

## Task 1: Extract a generic job kind from coding jobs

No behavior changes. `test/coding.test.ts` is the safety net; it must pass unchanged before and after.

**Files:** create `src/jobs.ts`; replace the body of `src/coding.ts` (lines 1-469); create `test/jobs.test.ts`.

**Design:** an exclusive kind keeps a `holder` in its jobs document: the job the screen belongs to and its deliveries in flight. A reporter's first phase, `wait`, takes it in the same commit that checks it, so two waiting deliveries cannot both pass; the answer, or an abort, releases it. `stop` increments the job's `stops` counter, and a delivery created before the latest stop ends without delivering. Each job also records its pending deliveries (waiting or submitting) and counts as working while it has any. Admission checks the stop count and marks the delivery submitting in one commit; `stop` waits for submitting deliveries before it aborts, so stopped work never runs after `stop` returns. Coding jobs are not exclusive and use the stop counter and delivery records.

**Interfaces produced:**
- `defineJobKind(options: JobKindOptions): JobKind`
- `type JobKindOptions = { kind: string; toolName: string; label: string; description: string; instructions: string; exclusive?: boolean }`
- `JobKind.jobOf(message): string | undefined`, `JobKind.list(harness, chatId): Promise<JobInfo[]>`, `JobKind.env(workspaces, agentId, target, context): Promise<ExecutionEnv | undefined>`, `JobKind.extensions(input: { agentId: string; job: Extension; model?: ModelRef }): JobExtensions`, `JobKind.isJob(reader, conversationId, context): Promise<boolean>`
- `type JobInfo = { name: string; conversationId: ConversationId; status: "working" | "idle" }`
- `type JobExtensions = { chat: Extension[]; job: Extension[] }`
- `coding.ts` keeps `CODING_TOOL_NAME`, `codingJobOf`, `codingJobs`, `codingEnv`, `codingExtensions`, `CodingJobInfo`, `CodingExtensions`.

- [ ] **Step 1: Run the safety net.** `bun test test/coding.test.ts` — expected: all pass.

- [ ] **Step 2: Create `src/jobs.ts`.**

```ts
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
} from "@earendil-works/chord/context";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  type ConversationId,
  type DocumentReader,
  type EntryId,
  type EnvTarget,
  type Extension,
  type Harness,
  type ModelRef,
  type TaskId,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import { conversationReference } from "./domain";
import { WORKSPACE_PATH, type Workspaces } from "./workspace";

export type JobKindOptions = {
  /** Names the kind's documents, tasks, request IDs, and message origin. Stored data depends on it: never rename. */
  kind: string;
  toolName: string;
  /** Lowercase noun for tool output and reports, such as "coding job". */
  label: string;
  /** The job tool's description for the bot's model. */
  description: string;
  /** The job's own instructions. */
  instructions: string;
  /** One job works at a time: a message to a job waits while another job of this kind works. */
  exclusive?: boolean;
};

export type JobInfo = {
  name: string;
  conversationId: ConversationId;
  status: "working" | "idle";
};

export type JobExtensions = {
  /** Offered in the bot's chat: the job tool. */
  chat: Extension[];
  /** Installed only: selected by the jobs themselves, never offered in the chat. */
  job: Extension[];
};

type Job = {
  conversationId: ConversationId;
  /** Answers already reported to the bot: several messages can end in one answer, reported once. */
  reported: EntryId[];
  /** Times the job was stopped; a delivery created before the latest stop is dropped. Unset means zero. */
  stops?: number;
  /**
   * Deliveries not yet admitted to the job, by reporter task ID: waiting for their turn, or submitting right now. A job
   * with any counts as working, and stop waits for submitting ones so its abort covers their work.
   */
  deliveries?: Record<string, "waiting" | "submitting">;
};

/** The job an exclusive kind's screen belongs to, and how many of its deliveries are in flight. */
type Holder = { name: string; deliveries: number };

type JobsState = { jobs: Record<string, Job>; holder?: Holder };

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
  /** The job's stop count when this delivery was created. Unset means zero. */
  stops?: number;
};

type ReporterState =
  | { phase: "wait" }
  | { phase: "deliver" }
  | { phase: "report"; report?: string };

const jobCard = z.object({ name: z.string().min(1) });

const WAIT_MS = 1000;
const STOP_POLL_MS = 50;
// A delivery that crashed while submitting stays marked; stop aborts after this long anyway.

const STOP_WAIT_MS = 10_000;

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const releaseHolder = (state: JobsState, name: string) => {
  if (state.holder?.name !== name) return;
  state.holder.deliveries -= 1;

  if (state.holder.deliveries <= 0) delete state.holder;
};

const settleDelivery = (job: Job | undefined, reporterId: TaskId<null>) => {
  if (job?.deliveries) delete job.deliveries[String(reporterId)];
};

// A job is busy while it has a run, from an input until its final answer, or a delivery that will start one.
const statusOf = async (reader: DocumentReader, job: Job, context: Context) =>
  Object.keys(job.deliveries ?? {}).length > 0 ||
  (await reader.snapshot(LiveDoc, job.conversationId, context))?.run
    ? ("working" as const)
    : ("idle" as const);

export type JobKind = ReturnType<typeof defineJobKind>;

/** Background jobs a bot hands work to: child conversations of its chat, built on Pi Durable's background subagent pattern. */
export function defineJobKind(options: JobKindOptions) {
  const { kind, toolName, label } = options;

  /** Marks a conversation as a job of this kind; its environment is the bot's workspace. */
  const Marker = defineDoc<{ job: boolean }>({
    kind: `crumble.${kind}-job`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ job: false }),
  });

  const Jobs = defineDoc<JobsState>({
    kind: `crumble.${kind}-jobs`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ jobs: {} }),
  });

  // The job's conversation is owned by this task so it outlives the bot's turns and Esc.
  const Anchor = defineTask<null, { phase: "done" }, null>({
    name: `crumble.${kind}-anchor`,
    version: 1,
    initial: () => ({ phase: "done" }),
    phases: {
      done: (_anchor, runtime, taskContext) =>
        runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          taskContext,
        ),
    },
    abort: (_anchor, runtime, taskContext) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        taskContext,
      ),
  });

  // Delivers one message to a job and reports its answer to the bot. Request IDs keep a restart from delivering the
  // message or the report twice.
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: `crumble.${kind}-reporter`,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      // Drops a delivery whose job was stopped since, and for an exclusive kind takes the screen in the same commit,
      // so two waiting deliveries cannot both pass. A restart re-enters this phase and waits again.
      wait: async (reporter, runtime, taskContext) => {
        const { name, stops = 0 } = reporter.input;

        for (;;) {
          let waiting = false;

          await runtime.commit(async (tx) => {
            const state = await tx.doc(Jobs, runtime.conversationId);
            const job = state.jobs[name];

            if (!job || (job.stops ?? 0) !== stops) {
              settleDelivery(job, reporter.id);

              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }

            if (options.exclusive) {
              if (state.holder && state.holder.name !== name) {
                waiting = true;

                return undefined;
              }

              state.holder = {
                name,
                deliveries: (state.holder?.deliveries ?? 0) + 1,
              };
            }

            return { status: "running", checkpoint: { phase: "deliver" } };
          }, taskContext);

          if (!waiting) return;

          await awaitWithContext(
            new Promise((resolve) => setTimeout(resolve, WAIT_MS)),
            taskContext,
          );
        }
      },
      // Admission checks the stop count and marks the delivery as submitting in one commit; stop waits for submitting
      // deliveries before it aborts. So work is either never submitted, or submitted before the abort that cancels it.
      deliver: async (reporter, runtime, taskContext) => {
        const { name, conversationId, message, followUp } = reporter.input;
        let admitted = false;

        await runtime.commit(async (tx) => {
          const state = await tx.doc(Jobs, runtime.conversationId);
          const job = state.jobs[name];

          if (!job || (job.stops ?? 0) !== (reporter.input.stops ?? 0)) {
            settleDelivery(job, reporter.id);
            releaseHolder(state, name);

            return { status: "running", checkpoint: { phase: "report" } };
          }

          job.deliveries = {
            ...job.deliveries,
            [String(reporter.id)]: "submitting",
          };
          admitted = true;

          return undefined;
        }, taskContext);

        if (!admitted) return;

        const job = (await runtime.conversation(conversationId, taskContext))!;

        const submission = await job.submit(
          {
            type: "input",
            content: message,
            whenBusy: followUp ? "followUp" : "steer",
            requestId: `${kind}:${reporter.id}`,
          },
          taskContext,
        );

        await runtime.commit(async (tx) => {
          settleDelivery(
            (await tx.doc(Jobs, runtime.conversationId)).jobs[name],
            reporter.id,
          );
        }, taskContext);

        const settled = await submission.wait(taskContext);

        await runtime.commit(async (tx) => {
          const state = await tx.doc(Jobs, runtime.conversationId);

          // The answer frees the screen for the next job, whether it reports or not.
          releaseHolder(state, name);

          const next = (report?: string) =>
            ({
              status: "running",
              checkpoint: { phase: "report", report },
            }) as const;

          // Aborted means stopped or withdrawn: nothing to report.
          if (settled.status === "unanswered")
            return next(
              settled.reason === "aborted"
                ? undefined
                : `[${label} ${name} failed: ${settled.reason}]`,
            );

          if (settled.type !== "input") return next();
          const job = state.jobs[name];

          if (!job || job.reported.includes(settled.answer)) return next();
          job.reported.push(settled.answer);

          const answer = (await tx.entry(AssistantEntry, settled.answer))
            ?.model?.[0];

          return next(
            `[${label} ${name} finished] ${answer?.role === "assistant" ? textOf(answer) : ""}`,
          );
        }, taskContext);
      },
      report: async (reporter, runtime, taskContext) => {
        const { report } = reporter.state.checkpoint;

        if (report !== undefined) {
          const chat = (await runtime.conversation(
            runtime.conversationId,
            taskContext,
          ))!;

          // The model reads the framed report; the owner sees the job's words, labelled with their origin.
          const text = report.replace(/^\[[^\]]*\] ?/, "");

          await chat.submit(
            {
              type: "input",
              content: report,
              whenBusy: "followUp",
              requestId: `${kind}-report:${reporter.id}`,
              entry: {
                kind: "crumble.message",
                data: { text, origin: { kind, name: reporter.input.name } },
              },
            },
            taskContext,
          );
        }

        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          taskContext,
        );
      },
    },
    abort: (reporter, runtime, taskContext) =>
      runtime.commit(async (tx) => {
        const state = await tx.doc(Jobs, runtime.conversationId);

        settleDelivery(state.jobs[reporter.input.name], reporter.id);

        // An aborted delivery that held the screen frees it.
        if (reporter.state.checkpoint.phase === "deliver")
          releaseHolder(state, reporter.input.name);

        return { status: "terminal", outcome: { status: "aborted" } };
      }, taskContext),
  });

  return {
    toolName,

    /** The job a successful tool result shows as a card; a listing or a failed call shows none. */
    jobOf(message: {
      role: string;
      toolName?: string;
      isError?: boolean;
      toolDetails?: unknown;
    }): string | undefined {
      if (
        message.role !== "toolResult" ||
        message.toolName !== toolName ||
        message.isError
      )
        return undefined;

      return jobCard.safeParse(message.toolDetails).data?.name;
    },

    /** The jobs of a bot's chat, oldest first: conversation IDs only grow, whereas record keys reorder numeric names. */
    async list(harness: Harness, chatId: ConversationId): Promise<JobInfo[]> {
      const jobs =
        (await harness.snapshot(Jobs, chatId, BACKGROUND_CONTEXT))?.jobs ?? {};

      const found = await Promise.all(
        Object.entries(jobs).map(async ([name, job]) => ({
          name,
          conversationId: job.conversationId,
          status: await statusOf(harness, job, BACKGROUND_CONTEXT),
        })),
      );

      return found.sort(
        (a, b) => Number(a.conversationId) - Number(b.conversationId),
      );
    },

    /** Whether the conversation is a job of this kind. */
    async isJob(
      reader: DocumentReader,
      conversationId: ConversationId,
      context: Context,
    ) {
      return (
        (await reader.snapshot(Marker, conversationId, context))?.job === true
      );
    },

    /**
     * A job's environment is its bot's workspace. Any other conversation, such as the bot's chat, gets none, so a
     * tool that wrongly reached for a shell would fail instead of touching the workspace.
     */
    async env(
      workspaces: Workspaces,
      agentId: string,
      target: EnvTarget,
      context: Context,
    ): Promise<ExecutionEnv | undefined> {
      const marker = await target.read.snapshot(
        Marker,
        target.conversationId,
        context,
      );

      return marker?.job ? workspaces.env(agentId) : undefined;
    },

    extensions(input: {
      agentId: string;
      /** The job's own extension: its tools and hooks. */
      job: Extension;
      /** The job's model; unset, a job starts with the bot's model. */
      model?: ModelRef;
    }): JobExtensions {
      const { agentId, job } = input;

      const tool = defineTool({
        name: toolName,
        description: options.description,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("start"),
            Type.Literal("send"),
            Type.Literal("stop"),
            Type.Literal("status"),
          ]),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          message: Type.Optional(
            Type.String({ minLength: 1, maxLength: 32000 }),
          ),
          followUp: Type.Optional(Type.Boolean()),
        }),
        callers: ["model"],
        // A rerun of stop or send after a crash could hit newer work; the model can check with status.
        replay: "unsafe",
        execute: async (args, api, callContext) => {
          const { action, name, message, followUp } = args;

          const reply = (text: string, found?: JobInfo) => {
            const result = { output: [{ type: "text" as const, text }] };

            if (!found) return result;

            // Clients attach a job card to the job's conversation through the details.
            return {
              ...result,
              details: {
                name: found.name,
                status: found.status,
                conversationId: conversationReference(
                  agentId,
                  Number(found.conversationId),
                ),
              },
            };
          };

          const jobs =
            (await api.snapshot(Jobs, api.conversationId, callContext))?.jobs ??
            {};

          if (action === "status") {
            const names = name === undefined ? Object.keys(jobs) : [name];
            const found: JobInfo[] = [];

            for (const each of names) {
              const job = Object.hasOwn(jobs, each) ? jobs[each] : undefined;

              if (job)
                found.push({
                  name: each,
                  conversationId: job.conversationId,
                  status: await statusOf(api, job, callContext),
                });
            }

            const text = found.length
              ? found.map((each) => `${each.name}: ${each.status}`).join("\n")
              : `No ${label}s.`;

            // Details describe one job; a listing has none.
            return reply(text, name === undefined ? undefined : found[0]);
          }

          if (name === undefined) return reply(`${action} needs a name.`);
          const existing = Object.hasOwn(jobs, name) ? jobs[name] : undefined;

          if (action !== "start" && !existing)
            return reply(`No ${label} named ${name}.`);

          if (action === "stop") {
            // Drops deliveries still waiting for the screen, then aborts the job's current answer and tools and its
            // queued messages. It stays usable.
            await api.commit(async (tx) => {
              const job = (await tx.doc(Jobs, api.conversationId)).jobs[name];

              if (job) job.stops = (job.stops ?? 0) + 1;
            }, callContext);

            // A delivery admitted before the stop count changed finishes submitting first, so the abort covers it.
            for (
              let waited = 0;
              waited < STOP_WAIT_MS &&
              Object.values(
                (await api.snapshot(Jobs, api.conversationId, callContext))
                  ?.jobs[name]?.deliveries ?? {},
              ).includes("submitting");
              waited += STOP_POLL_MS
            )
              await awaitWithContext(
                new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS)),
                callContext,
              );

            await (await api.conversation(
              existing!.conversationId,
              callContext,
            ))!.abort(callContext);

            return reply(`Stopped ${name}.`, {
              name,
              conversationId: existing!.conversationId,
              status: "idle",
            });
          }

          if (message === undefined) return reply(`${action} needs a message.`);

          const result = await api.commit(async (tx) => {
            const state = await tx.doc(Jobs, api.conversationId);

            // Both tasks belong to the bot's chat and are background: its Esc and idle waits skip them.
            const background = {
              ownership: { kind: "conversation" },
              background: true,
            } as const;

            if (action === "start") {
              if (Object.hasOwn(state.jobs, name))
                return {
                  text: `${name} already exists; use send.`,
                  found: undefined,
                };

              const anchor = await tx.createTask(Anchor, null, background);

              // Starts as a copy of the bot's agent, then keeps only the job's own tools. Selecting exactly the job
              // extension also drops the bot's other tools, hooks, and prompt sections, so a job can neither start
              // jobs nor delegate, schedule, or reach integrations.
              const child = await tx.createConversation({
                ownership: { kind: "task", taskId: anchor },
              });

              await configure(tx, child.id, {
                extensions: [job],
                tools: null,
                modelTools: null,
                instructions: options.instructions,
                cwd: WORKSPACE_PATH,
                ...(input.model && { model: input.model }),
              });
              (await tx.doc(Marker, child.id)).job = true;
              state.jobs[name] = { conversationId: child.id, reported: [] };
            }

            const record = state.jobs[name]!;
            const conversationId = record.conversationId;

            const reporter = await tx.createTask(
              Reporter,
              {
                name,
                conversationId,
                message,
                followUp: action === "send" && followUp === true,
                stops: record.stops ?? 0,
              },
              background,
            );

            record.deliveries = {
              ...record.deliveries,
              [String(reporter)]: "waiting",
            };

            return {
              text: action === "send" ? `Sent to ${name}.` : `Started ${name}.`,
              found: { name, conversationId, status: "working" as const },
            };
          }, callContext);

          // The card shows the started or messaged job, so the turn ends with it, as after `show`.
          return result.found
            ? {
                ...reply(result.text, result.found),
                control: { terminate: true },
              }
            : reply(result.text);
        },
      });

      const chat = defineExtension({
        name: toolName,
        tools: [tool],
        tasks: [Anchor, Reporter],
      });

      return { chat: [chat], job: [job] };
    },
  };
}
```

- [ ] **Step 3: Replace `src/coding.ts` with the coding kind.**

```ts
import type { Context } from "@earendil-works/chord";
import {
  ToolTask,
  defineExtension,
  hook,
  type ConversationId,
  type EnvTarget,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { Agent } from "./domain";
import { defineJobKind, type JobExtensions, type JobInfo } from "./jobs";
import { WORKSPACE_PATH, type Workspaces } from "./workspace";

export const CODING_TOOL_NAME = "coding";

// Tools whose success may have changed the workspace's files. A failed bash can still have written files.
const FILE_CHANGING_TOOLS = new Set(["write", "edit", "bash"]);

const coding = defineJobKind({
  kind: "coding",
  toolName: CODING_TOOL_NAME,
  label: "coding job",
  description:
    `Run coding jobs: background agents that read, write, edit files and run shell commands in your persistent workspace (${WORKSPACE_PATH}), which survives restarts and is shared by all your jobs. ` +
    "Actions: start (name, message: the full task, since the job knows nothing else), send (name, message; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "Jobs keep working after your turn ends. Their final answer arrives later as a message from the job; then tell the owner the outcome. Do not wait or poll for it.",
  instructions: `You are a coding job for another bot. Do the task you are given with your read, write, edit, and bash tools, working in ${WORKSPACE_PATH}, a persistent workspace that earlier jobs of this bot also used. Verify your work by running it. Finish with a short report: what you did, what you verified, and what is left.`,
});

/** The job a successful `coding` result shows as a card; a listing or a failed call shows none. */
export const codingJobOf = coding.jobOf;

export type CodingJobInfo = JobInfo;

export type CodingExtensions = JobExtensions;

export const codingJobs = (harness: Harness, chatId: ConversationId) =>
  coding.list(harness, chatId);

export const codingEnv = (
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
): Promise<ExecutionEnv | undefined> =>
  coding.env(workspaces, agentId, target, context);

/** Lets a bot run coding jobs: child conversations with Pi's coding tools in the bot's workspace. */
export function codingExtensions(
  agent: Pick<Agent, "id">,
  workspaces: Workspaces,
): CodingExtensions {
  const job = defineExtension({
    name: "coding-job",
    tools: createCodingTools().tools,
    hooks: [
      hook(ToolTask, {
        // A crash then loses at most the call in flight.
        afterTool: async (call, _result, api, context) => {
          if (!FILE_CHANGING_TOOLS.has(call.name)) return undefined;

          if (await coding.isJob(api, api.conversationId, context))
            await workspaces.sync(agent.id, context);

          return undefined;
        },
      }),
    ],
  });

  return coding.extensions({ agentId: agent.id, job });
}
```

- [ ] **Step 4: Run the safety net.** `bun test test/coding.test.ts && bun run typecheck` — expected: all pass, no type errors.

- [ ] **Step 5: Write the failing test for exclusive kinds.** Create `test/jobs.test.ts`. It runs a scripted model as both bot and jobs. Job `a`'s model call blocks until released; job `b` must not get a model call before `a` answers. More tests: two waiting jobs start one at a time; stopping a waiting job drops its delivery; a non-exclusive kind does not wait.

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@earendil-works/chord";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { defineJobKind, type JobKindOptions } from "../src/jobs";
import { AgentRuntime } from "../src/runtime";
import { Store } from "../src/store";
import type { Workspaces } from "../src/workspace";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

class DirectoryWorkspaces implements Workspaces {
  readonly desktop = false;

  constructor(readonly dir: string) {}

  env(_agentId: string) {
    return new NodeExecutionEnv({ cwd: this.dir });
  }

  async sync(_agentId: string, _context: Context) {}

  async restart(_agentId: string, _context: Context) {}

  async close(_context: Context) {}
}

const kindOptions = (exclusive: boolean): JobKindOptions => ({
  kind: exclusive ? "test-exclusive" : "test-parallel",
  toolName: "errand",
  label: "errand",
  description: "Run errands.",
  instructions: "You run one errand.",
  exclusive,
});

const exclusiveKind = defineJobKind(kindOptions(true));
const parallelKind = defineJobKind(kindOptions(false));

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

/** Each job's model call waits until the test releases that job. */
class Gates {
  readonly started: string[] = [];
  private readonly gates = new Map<string, () => void>();
  private readonly waits = new Map<string, Promise<void>>();

  wait(name: string) {
    this.started.push(name);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    this.gates.set(name, open);
    this.waits.set(name, gate);

    return gate;
  }

  release(name: string) {
    this.gates.get(name)?.();
  }
}

/** The bot starts or stops the errand its message names; a job's model waits at its gate. */
function script(gates: Gates): FauxResponseFactory {
  return async (context) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const text = textOf(last);

    if (!tools.includes("errand")) {
      const name = text.replace("errand ", "");
      await gates.wait(name);

      return fauxAssistantMessage([fauxText(`${name} done`)]);
    }

    if (text.startsWith("[errand") || last.role === "toolResult")
      return fauxAssistantMessage([fauxText("Noted.")]);

    const [action, name] = text.split(" ");

    return fauxAssistantMessage(
      fauxToolCall("errand", {
        action: action!,
        name: name!,
        ...(action === "start" && { message: `errand ${name}` }),
      }),
      { stopReason: "toolUse" },
    );
  };
}

async function open(kind: typeof exclusiveKind) {
  const dir = mkdtempSync(join(tmpdir(), "bot-jobs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent({
    name: "Runner",
    avatar: "bot",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: ["errand"],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const gates = new Gates();
  const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
  faux.setResponses(Array.from({ length: 60 }, () => script(gates)));
  const models = createModels();
  models.setProvider(faux.provider);

  const workspaces = new DirectoryWorkspaces(dir);
  const job = defineExtension({ name: "errand-job" });
  const extensions = kind.extensions({ agentId: agent.id, job });

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: () => extensions.chat,
    taskExtensions: () => extensions.job,
    env: (agentId, target, context) =>
      kind.env(workspaces, agentId, target, context),
  });

  cleanups.push(() => runtime.close());

  const chat = await runtime.openChat(agent);
  let requests = 0;

  // Each bot message runs one turn; the next waits until the chat is idle again.
  const say = async (text: string) => {
    await runtime.submit(agent, chat, text, `req-${++requests}`);
    await Bun.sleep(200);
  };

  // The bot's latest job tool result, such as a status listing.
  const lastToolResult = async () =>
    (await runtime.snapshot(agent, chat)).messages.findLast(
      (message) => message.toolName === "errand",
    )?.content;

  return { gates, say, lastToolResult };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));

  expect(check()).toBe(true);
}

// Long enough for a job that did not wait to reach its model.
const SETTLE_MS = 1500;

test("an exclusive job waits while another job of its kind works", async () => {
  const { gates, say } = await open(exclusiveKind);

  await say("start a");
  await until(() => gates.started.includes("a"));
  await say("start b");

  await Bun.sleep(SETTLE_MS);
  expect(gates.started).toEqual(["a"]);

  gates.release("a");
  await until(() => gates.started.includes("b"));
  gates.release("b");
});

test("waiting jobs start one at a time when the screen frees up", async () => {
  const { gates, say } = await open(exclusiveKind);

  await say("start a");
  await until(() => gates.started.includes("a"));
  await say("start b");
  await say("start c");

  gates.release("a");
  await until(() => gates.started.length === 2);
  await Bun.sleep(SETTLE_MS);
  // Only one of b and c holds the screen.
  expect(gates.started).toHaveLength(2);

  const second = gates.started[1]!;
  gates.release(second);
  await until(() => gates.started.length === 3);
  gates.release(gates.started[2]!);
});

test("a job waiting for the screen reports as working", async () => {
  const { gates, say, lastToolResult } = await open(exclusiveKind);

  await say("start a");
  await until(() => gates.started.includes("a"));
  await say("start b");
  await say("status b");

  expect(await lastToolResult()).toBe("b: working");
  gates.release("a");
  await until(() => gates.started.includes("b"));
  gates.release("b");
});

test("stopping a waiting job cancels its delivery", async () => {
  const { gates, say } = await open(exclusiveKind);

  await say("start a");
  await until(() => gates.started.includes("a"));
  await say("start b");
  await say("stop b");

  gates.release("a");
  await Bun.sleep(SETTLE_MS);
  expect(gates.started).toEqual(["a"]);
});

test("jobs of other kinds run side by side", async () => {
  const { gates, say } = await open(parallelKind);

  await say("start a");
  await say("start b");
  await until(() => gates.started.includes("b"));
  gates.release("a");
  gates.release("b");
});
```

- [ ] **Step 6: Run it.** `bun test test/jobs.test.ts` — expected: 4 pass. Without the stop counter, the stop test fails: the stopped job still runs once the first job finishes. The one-at-a-time test guards a race and may pass by timing even without the atomic holder.

- [ ] **Step 7: Full check.** `bun run check` — expected: pass.

- [ ] **Step 8: Commit** (when the owner asks): `git add src/jobs.ts src/coding.ts test/jobs.test.ts && git commit -m "refactor(coding): extract a generic job kind"`

## Task 2: Keep each bot's machine between boots

Today every boot replaces the bot's machine, so programs installed outside `/workspace` are gone after each idle stop. Feature 0002 expects them to last until the image changes. A boot now restarts the bot's existing machine and replaces it only when it was made from another image, cannot start, or cannot get its proxy port back. One machine per bot stays as is.

The machine's network proxy address is fixed when the machine is created (Microsandbox's `modify()` cannot change it), so each machine keeps the proxy port it was created with. The machine records its image and port in `/etc/crumble-workspace.json`, on its own root disk, which survives a clean stop. A hard kill can lose root disk writes that were not synced; `sync` already runs after file-changing tools and at stop.

**Files:** modify `src/workspace-proxy.ts` (`WorkspaceProxyOptions` lines 6-11, `listen` at line 235), `src/microsandbox-workspaces.ts` (`boot` lines 275-316, new helpers after `ensureVolume` at line 328), `test/workspace-proxy.test.ts`, `test/microsandbox-workspaces.test.ts`, `docs/architecture.md` (workspace section, line 46).

**Interfaces produced:**
- `WorkspaceProxyOptions.port?: number` — listen on this port instead of a free one; rejects with `EADDRINUSE` when taken.
- Guest file `/etc/crumble-workspace.json`: `{ "image": string, "proxyPort": number }`.
- `MicrosandboxWorkspaces.boot` keeps its signature; Task 4 changes which image it asks for.

- [ ] **Step 1: Write the failing proxy test.** Append to `test/workspace-proxy.test.ts`:

```ts
test("the proxy listens on a requested port, and refuses a taken one", async () => {
  const first = await startWorkspaceProxy({ decide: () => true });
  const port = Number(first.address.split(":")[1]);
  await first.close();

  const again = await startWorkspaceProxy({ decide: () => true, port });
  expect(again.address).toBe(`127.0.0.1:${port}`);

  await expect(startWorkspaceProxy({ decide: () => true, port })).rejects.toThrow("EADDRINUSE");
  await again.close();
});
```

- [ ] **Step 2: Run.** `bun test test/workspace-proxy.test.ts` — expected: FAIL, the second proxy gets another port.

- [ ] **Step 3: Implement.** In `src/workspace-proxy.ts`, add to `WorkspaceProxyOptions`:

```ts
  /** Listen on this port, so a restarted machine finds its proxy at the address it was created with. */
  port?: number;
```

and change the listen call to `server.listen(options.port ?? 0, "127.0.0.1", resolve);`.

- [ ] **Step 4: Run.** `bun test test/workspace-proxy.test.ts` — expected: pass.

- [ ] **Step 5: Write the failing VM tests.** Append inside `describe.skipIf(!vmTests)("Microsandbox VM workspaces", ...)` in `test/microsandbox-workspaces.test.ts`, which already has `sh()` and `namePrefix`:

```ts
  test("programs and files outside the workspace survive an idle stop and a server restart", async () => {
    const first = new MicrosandboxWorkspaces(IMAGE, { namePrefix, idleTimeoutMs: 500 });
    const env = first.env("keeps");

    expect((await sh(env, "echo installed > /usr/local/bin/marker && sync && echo ok")).output).toBe("ok");
    // Idle stop, then the next operation boots the same machine again.
    await Bun.sleep(1500);
    expect((await sh(env, "cat /usr/local/bin/marker")).output).toBe("installed");
    await first.close();

    // A new server process: new MicrosandboxWorkspaces, same machine name.
    const second = new MicrosandboxWorkspaces(IMAGE, { namePrefix });
    const again = second.env("keeps");
    expect((await sh(again, "cat /usr/local/bin/marker")).output).toBe("installed");
    // The proxy is back at the address the machine was created with.
    expect((await sh(again, "curl -sS -o /dev/null -w '%{http_code}' https://example.com")).output).toBe("200");
    await second.close();
  }, 180_000);

  // A second tag of the same image stands in for an image change without a second build.
  test.skipIf(!process.env.CRUMBLE_WORKSPACE_IMAGE_OTHER)("another image replaces the machine but keeps the workspace", async () => {
    const first = new MicrosandboxWorkspaces(IMAGE, { namePrefix });
    const env = first.env("swap");
    await sh(env, `echo kept > ${WORKSPACE_PATH}/kept.txt && echo gone > /usr/local/bin/marker && sync`);
    await first.close();

    const second = new MicrosandboxWorkspaces(process.env.CRUMBLE_WORKSPACE_IMAGE_OTHER!, { namePrefix });
    const again = second.env("swap");
    expect((await sh(again, `cat ${WORKSPACE_PATH}/kept.txt; cat /usr/local/bin/marker 2>/dev/null || echo none`)).output).toBe("kept\nnone");
    await second.close();
  }, 180_000);

  test("a machine left running by a killed server is taken over", async () => {
    const first = new MicrosandboxWorkspaces(IMAGE, { namePrefix });
    const env = first.env("orphan");
    await sh(env, "echo before > /usr/local/bin/marker && sync");
    // No close(): the machine keeps running, as after a crash.

    const second = new MicrosandboxWorkspaces(IMAGE, { namePrefix });
    expect((await sh(second.env("orphan"), "cat /usr/local/bin/marker")).output).toBe("before");
    await second.close();
    await first.close().catch(() => undefined);
  }, 180_000);
```

As built, the orphan case extends the existing test "a machine left behind by a killed server…" (now "…is taken over on the next boot") with a marker in `/usr/local/bin`, instead of a new test, and the image change test reads `CRUMBLE_WORKSPACE_IMAGE_OTHER` and is skipped without it. The second tag needs no Docker: `Image.save("crumble-workspace:dev", { outputPath })` then `Image.load(outputPath, { tag: "crumble-workspace:other" })` (README).

- [ ] **Step 6: Run them.** `CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev CRUMBLE_WORKSPACE_IMAGE_OTHER=crumble-workspace:other bun test test/microsandbox-workspaces.test.ts` — expected: FAIL in the first test, `cat: /usr/local/bin/marker: No such file or directory`, because each boot replaces the machine.

- [ ] **Step 7: Implement.** In `src/microsandbox-workspaces.ts`, add after `ensureVolume`:

```ts
const MACHINE_FILE = "/etc/crumble-workspace.json";
const STOP_TIMEOUT_MS = 10_000;

const machineRecord = z.object({ image: z.string(), proxyPort: z.number().int() });

type MachineRecord = z.infer<typeof machineRecord>;

/**
 * Starts the bot's existing machine, taking it over first if a server that died left it running. Undefined when there
 * is none or it does not start: the caller then creates a new one.
 */
async function resume(name: string): Promise<Sandbox | undefined> {
  try {
    const handle = await Sandbox.get(name);

    if (handle.status !== "stopped" && handle.status !== "created")
      await handle.stopWithTimeout(STOP_TIMEOUT_MS).catch(() => handle.kill());

    return await (await Sandbox.get(name)).start();
  } catch {
    return undefined;
  }
}

async function readMachineRecord(sandbox: Sandbox): Promise<MachineRecord | undefined> {
  try {
    const text = Buffer.from(await sandbox.fs().read(MACHINE_FILE)).toString("utf8");

    return machineRecord.safeParse(JSON.parse(text)).data;
  } catch {
    return undefined;
  }
}
```

Replace the body of `boot` up to the daemon upload with:

```ts
    const name = this.name(agentId);
    const image = this.image;

    await ensureVolume(name);

    const decide = ({ host, port }: { host: string; port: number }) =>
      this.network({ agentId, host, port });

    let sandbox: Sandbox | undefined;
    let proxy: WorkspaceProxy | undefined;
    let relay: Relay | undefined;

    try {
      // A restarted machine keeps what was installed outside /workspace. It must come back to its own image and the
      // proxy port it was created with, since its network settings are fixed at creation.
      sandbox = await resume(name);
      const record = sandbox && (await readMachineRecord(sandbox));

      if (sandbox && record?.image === image)
        proxy = await startWorkspaceProxy({ decide, port: record.proxyPort }).catch(() => undefined);

      if (!proxy) {
        await sandbox?.stop().catch(() => undefined);
        proxy = await startWorkspaceProxy({ decide });

        // replace() also takes over a machine that could not be resumed.
        sandbox = await Sandbox.builder(name)
          .image(image)
          .cpus(CPUS)
          .memory(MEMORY_MIB)
          .volume(WORKSPACE_PATH, (mount) => mount.named(name))
          .proxy((outbound) => outbound.httpConnect(proxy!.address))
          .replace()
          .create();

        const proxyPort = Number(proxy.address.split(":")[1]);
        await sandbox.fs().write(MACHINE_FILE, JSON.stringify({ image, proxyPort }));
        await flush(sandbox);
      }

      await sandbox!.fs().write(GUEST_DAEMON, await readFile(this.daemon));
      await run(sandbox!, `chmod 755 ${GUEST_DAEMON}`);
      relay = await startRelay(sandbox!);

      return {
        sandbox: sandbox!,
        relay,
        proxy,
        command: [process.execPath, BRIDGE_PATH, relay.socketPath],
      };
    } catch (error) {
      await relay?.close();
      await sandbox?.stop().catch(() => undefined);
      await proxy?.close();
      throw error;
    }
```

Remove the old `startWorkspaceProxy` call and builder block from `boot`; everything after `return` stays.

- [ ] **Step 8: Run.** The command from Step 6 — expected: all VM tests pass, including the existing conformance tests. Then `bun run check` — expected: pass.

- [ ] **Step 9: Document.** In `docs/architecture.md` (line 46), replace "everything outside `/workspace` is reset when the machine is replaced" with: "A boot restarts the bot's existing machine, so programs installed outside `/workspace` survive idle stops and server restarts. The machine records its image and proxy port in `/etc/crumble-workspace.json`; a boot replaces it, resetting everything outside `/workspace`, when its image changed, it does not start, or its proxy port is taken." In `CHANGELOG.md` under Unreleased: "Keep each bot's workspace machine between boots: programs installed outside `/workspace` now survive idle stops and server restarts, until the workspace image changes."

- [ ] **Step 10: Commit** (when the owner asks): `git add src/workspace-proxy.ts src/microsandbox-workspaces.ts test/workspace-proxy.test.ts test/microsandbox-workspaces.test.ts docs/architecture.md CHANGELOG.md && git commit -m "feat(workspace): keep each bot's machine between boots"`

## Task 3: Workspace images with a desktop target

**Files:** modify `workspace-image/Dockerfile`; create `workspace-image/desktop/desktop-start.sh`, `workspace-image/desktop/browser.sh`, `.github/workflows/workspace-image.yml`; modify `README.md` (workspace image section, lines 35-50).

**Interfaces produced:**
- Image target `base`: today's image.
- Image target `desktop`: `base` plus the bot desktop. Guest contract used by later tasks:
  - `/opt/crumble/desktop-start.sh` starts the session idempotently and exits 0 once cua-driver lists a Chromium window; it writes `/run/crumble-desktop.env` with `DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`, `CUA_DRIVER_RS_TELEMETRY_ENABLED=0`, `DO_NOT_TRACK=1`.
  - `cua-driver` on `PATH`, daemon serving at its default socket, started with `--grant existing-profile`.
  - Chromium's profile at `/workspace/.desktop/chromium`.

- [ ] **Step 1: Write the image.** Replace `workspace-image/Dockerfile`:

```dockerfile
# Guest images for workspaces. Debian (glibc), which cua-driver needs.
#   base:    every bot with a workspace (coding jobs)
#   desktop: base plus the bot desktop for desktop jobs: Xvnc, Openbox, tint2, Chromium, cua-driver
FROM node:24-trixie-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /usr/local/bin/
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl git make openssh-client python3 python3-venv ripgrep \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace

FROM base AS desktop
ARG TARGETARCH
ARG CUA_DRIVER_VERSION=0.38.0
ARG CUA_DRIVER_SHA256_ARM64=80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d
ARG CUA_DRIVER_SHA256_X86_64=31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server openbox tint2 chromium xdotool imagemagick fonts-dejavu-core fonts-noto-color-emoji \
    socat procps dbus-x11 at-spi2-core x11-utils zenity \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  case "$TARGETARCH" in arm64) arch=arm64; sum=$CUA_DRIVER_SHA256_ARM64 ;; amd64) arch=x86_64; sum=$CUA_DRIVER_SHA256_X86_64 ;; *) echo "unsupported $TARGETARCH"; exit 1 ;; esac; \
  file="cua-driver-rs-${CUA_DRIVER_VERSION}-linux-${arch}-binary.tar.gz"; \
  curl -fsSLo "/tmp/$file" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_DRIVER_VERSION}/$file"; \
  echo "$sum  /tmp/$file" | sha256sum -c -; \
  tar -xzf "/tmp/$file" -C /usr/local/bin cua-driver; \
  rm "/tmp/$file"; \
  CUA_DRIVER_RS_TELEMETRY_ENABLED=0 cua-driver telemetry disable
ENV CUA_DRIVER_RS_TELEMETRY_ENABLED=0 DO_NOT_TRACK=1
# Every window maximized and undecorated: the job sees content, not window chrome.
RUN mkdir -p /opt/crumble \
  && sed 's|<applications>|<applications><application class="*"><decor>no</decor><maximized>yes</maximized></application>|' \
    /etc/xdg/openbox/rc.xml > /opt/crumble/openbox-rc.xml
COPY desktop/desktop-start.sh desktop/browser.sh /opt/crumble/
RUN chmod 755 /opt/crumble/*.sh
```

- [ ] **Step 2: Write `workspace-image/desktop/desktop-start.sh`.**

```bash
#!/bin/bash
# Starts the bot desktop once per boot; a second run while it is up only waits for it.
# The host runs this at boot, outside pi-env, whose daemon kills every process it started when it stops.
set -u
export DISPLAY=:1
if ! pgrep -x Xvnc >/dev/null; then
  rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
  # Localhost only: the viewer (milestone 2) reaches it through the host.
  nohup Xvnc :1 -geometry 1280x800 -depth 24 -SecurityTypes None -localhost yes -rfbport 5900 -AlwaysShared >/tmp/xvnc.log 2>&1 &
  for _ in $(seq 50); do [ -S /tmp/.X11-unix/X1 ] && break; sleep 0.1; done
  eval "$(dbus-launch --sh-syntax)"
  {
    echo "export DISPLAY=:1 CUA_DRIVER_RS_TELEMETRY_ENABLED=0 DO_NOT_TRACK=1"
    echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'"
  } > /run/crumble-desktop.env
  nohup /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi.log 2>&1 &
  # Chromium reads the accessibility switch only at startup; turn it on before the browser starts.
  for _ in $(seq 50); do
    dbus-send --session --dest=org.a11y.Bus /org/a11y/bus org.freedesktop.DBus.Properties.Set \
      string:org.a11y.Status string:IsEnabled variant:boolean:true 2>/dev/null && break
    sleep 0.1
  done
  nohup cua-driver serve --grant existing-profile >/tmp/cua-driver.log 2>&1 &
  nohup openbox --config-file /opt/crumble/openbox-rc.xml >/tmp/openbox.log 2>&1 &
  sleep 0.5
  nohup tint2 >/tmp/tint2.log 2>&1 &
  nohup /opt/crumble/browser.sh >/tmp/browser.log 2>&1 &
fi
. /run/crumble-desktop.env
for _ in $(seq 150); do
  cua-driver call list_windows '{}' 2>/dev/null | grep -q '"app_name": "Chromium"' && exit 0
  sleep 0.2
done
echo "bot desktop did not start; see /tmp/*.log" >&2
exit 1
```

- [ ] **Step 3: Write `workspace-image/desktop/browser.sh`.**

```bash
#!/bin/bash
# Keeps Chromium running; the job cannot rely on the panel to relaunch it.
. /run/crumble-desktop.env
mkdir -p /workspace/.desktop/chromium
while true; do
  # --no-sandbox: the guest runs as root, and the VM is the sandbox.
  chromium --no-sandbox --test-type --no-first-run --disable-gpu --force-renderer-accessibility \
    --user-data-dir=/workspace/.desktop/chromium --start-maximized about:blank
  sleep 1
done
```

- [ ] **Step 4: Build both targets.**

```bash
docker build --target base -t crumble-workspace:dev workspace-image
docker build --target desktop -t crumble-workspace-desktop:dev workspace-image
```

Expected: both succeed; the desktop build prints `OK` from `sha256sum -c` and `Telemetry disabled`.

- [ ] **Step 5: Smoke-test the desktop image in Microsandbox.** Load it as the README describes for the base image (`docker save` then `Image.load`), then:

```bash
bun -e '
import { Sandbox } from "microsandbox";
const sb = await Sandbox.builder("crumble-desktop-smoke").image("crumble-workspace-desktop:dev").memory(2048).replace().create();
const r = await sb.exec("/bin/sh", ["-c", "/opt/crumble/desktop-start.sh && . /run/crumble-desktop.env && cua-driver call list_windows {} | grep app_name && cua-driver telemetry status"]);
console.log(r.code, r.stdout(), r.stderr());
await sb.stop(); await (await Sandbox.get("crumble-desktop-smoke")).remove();
'
```

Expected: exit 0, `"app_name": "Chromium"`, `"app_name": "Tint2"`, and `Telemetry: disabled`.

- [ ] **Step 6: Add the image workflow.** Create `.github/workflows/workspace-image.yml`:

```yaml
name: Workspace images
on:
  workflow_dispatch:
  push:
    tags: ["workspace-image-v*"]
permissions:
  contents: read
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target: [base, desktop]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Tag
        id: tag
        run: |
          name=crumble-workspace; [ "${{ matrix.target }}" = desktop ] && name=crumble-workspace-desktop
          version=${GITHUB_REF_NAME#workspace-image-v}; [ "$GITHUB_REF_TYPE" = tag ] || version=sha-${GITHUB_SHA::12}
          echo "ref=ghcr.io/${{ github.repository_owner }}/$name:$version" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: workspace-image
          target: ${{ matrix.target }}
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.tag.outputs.ref }}
```

It is not a push or pull request workflow, so the two-minute unit-test limit does not apply. Check the action versions against the ones already used in `.github/workflows/contract.yml` and match them.

- [ ] **Step 7: Document.** In `README.md`, replace the workspace image steps (lines 35-43) so they build both targets as in Step 4, load both, and set `CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev` and `CRUMBLE_WORKSPACE_DESKTOP_IMAGE=crumble-workspace-desktop:dev`. Add: "Published images: `ghcr.io/crumble-project/crumble-workspace` and `ghcr.io/crumble-project/crumble-workspace-desktop`, built by the Workspace images workflow on `workspace-image-v*` tags."

- [ ] **Step 8: Commit** (when the owner asks): `git add workspace-image .github/workflows/workspace-image.yml README.md && git commit -m "feat(workspace): add a desktop image target"`

## Task 4: Workspaces boot the desktop image for desktop bots

**Files:** modify `src/workspace.ts` (lines 21-32), `src/microsandbox-workspaces.ts` (options lines 32-38, `microsandboxWorkspacesFromEnv` lines 47-58, `Running` lines 60-65, `Workspace.ensureStarted` lines 138-150, `MicrosandboxWorkspaces` constructor and `boot` lines 205-316); modify `test/microsandbox-workspaces.test.ts`; update `DirectoryWorkspaces` in `test/coding.test.ts` (lines 34-52) with the two new members.

**Interfaces produced:**
- `Workspaces.desktop: boolean` — the server can give bots a bot desktop.
- `Workspaces.restart(agentId: string, context: Context): Promise<void>` — stops the bot's machine; the next operation boots the image the bot needs now.
- `MicrosandboxWorkspacesOptions.desktopImage?: string`, `MicrosandboxWorkspacesOptions.wantsDesktop?: (agentId: string) => boolean`
- `microsandboxWorkspacesFromEnv(env, options)` reads `CRUMBLE_WORKSPACE_DESKTOP_IMAGE`.
- `MicrosandboxWorkspaces.imageFor(agentId: string): string`

- [ ] **Step 1: Write the failing tests.** Append to the `workspace configuration` describe block in `test/microsandbox-workspaces.test.ts`:

```ts
  test("desktop bots boot the desktop image when one is configured", () => {
    const desktopBots = new Set(["desk"]);

    const workspaces = microsandboxWorkspacesFromEnv(
      {
        CRUMBLE_WORKSPACE_IMAGE: "crumble-workspace:dev",
        CRUMBLE_WORKSPACE_DESKTOP_IMAGE: "crumble-workspace-desktop:dev",
      },
      { wantsDesktop: (agentId) => desktopBots.has(agentId) },
    )!;

    expect(workspaces.desktop).toBe(true);
    expect(workspaces.imageFor("desk")).toBe("crumble-workspace-desktop:dev");
    expect(workspaces.imageFor("plain")).toBe("crumble-workspace:dev");
  });

  test("without a desktop image no bot gets a bot desktop", () => {
    const workspaces = microsandboxWorkspacesFromEnv(
      { CRUMBLE_WORKSPACE_IMAGE: "crumble-workspace:dev" },
      { wantsDesktop: () => true },
    )!;

    expect(workspaces.desktop).toBe(false);
    expect(workspaces.imageFor("desk")).toBe("crumble-workspace:dev");
  });
```

- [ ] **Step 2: Run them.** `bun test test/microsandbox-workspaces.test.ts` — expected: FAIL, `workspaces.desktop` is undefined and `imageFor` is not a function.

- [ ] **Step 3: Extend the seam.** In `src/workspace.ts`, add to `interface Workspaces`:

```ts
  /** Whether bots can get a bot desktop: the workspace image for them has one. */
  readonly desktop: boolean;
  /** Stops the bot's machine, whether busy or not; the next operation boots the image the bot needs now. */
  restart(agentId: string, context: Context): Promise<void>;
```

- [ ] **Step 4: Implement in `src/microsandbox-workspaces.ts`.**

Options and env:

```ts
export type MicrosandboxWorkspacesOptions = {
  idleTimeoutMs?: number;
  /** Decides each outbound connection; defaults to allowing all. */
  network?: WorkspaceNetworkPolicy;
  /** Prefix of sandbox and volume names, which are global to the Microsandbox home. */
  namePrefix?: string;
  /** The image for bots with a bot desktop: the base image plus the desktop. */
  desktopImage?: string;
  /** Whether the bot needs its bot desktop; read at each boot. */
  wantsDesktop?: (agentId: string) => boolean;
};

const DESKTOP_START = "/opt/crumble/desktop-start.sh";

export function microsandboxWorkspacesFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: MicrosandboxWorkspacesOptions = {},
) {
  const image = env.CRUMBLE_WORKSPACE_IMAGE;
  const desktopImage = env.CRUMBLE_WORKSPACE_DESKTOP_IMAGE;

  return image
    ? new MicrosandboxWorkspaces(image, {
        ...options,
        ...(desktopImage && { desktopImage }),
      })
    : undefined;
}
```

`Running` records the image it booted:

```ts
type Running = {
  sandbox: Sandbox;
  relay: Relay;
  proxy: WorkspaceProxy;
  command: readonly string[];
  image: string;
};
```

`Workspace.ensureStarted` reboots when the bot now needs another image:

```ts
  ensureStarted() {
    return this.exclusive(async () => {
      const image = this.owner.imageFor(this.agentId);

      if (
        this.running &&
        this.running.image === image &&
        (await isAlive(this.running.sandbox))
      )
        return this.running.command;

      if (this.running) await this.teardown();

      this.running = await this.owner.boot(this.agentId);
      this.armIdleTimer();

      return this.running.command;
    });
  }
```

`Workspace.stop` gains a `keepConnection` flag so a restart does not close pi-env's `Connection`, which cannot reconnect after `close()`:

```ts
  /** Stops only an idle workspace unless forced. A restart keeps the connection, which reconnects on next use. */
  stop(force: boolean, keepConnection = false) {
    clearTimeout(this.idleTimer);

    return this.exclusive(async () => {
      // pi-env's Connection reconnects after losing its bridge but not after close(), so only the last stop closes it.
      if (force && !keepConnection) this.connection.close();

      if (!this.running || (!force && this.inflight > 0)) return;

      await this.teardown();
    });
  }
```

In `MicrosandboxWorkspaces`, store the new options in the constructor and add:

```ts
  private readonly desktopImage: string | undefined;
  private readonly wantsDesktop: (agentId: string) => boolean;

  // in the constructor, after namePrefix:
  this.desktopImage = options.desktopImage;
  this.wantsDesktop = options.wantsDesktop ?? (() => false);

  get desktop() {
    return this.desktopImage !== undefined;
  }

  imageFor(agentId: string) {
    return this.desktopImage && this.wantsDesktop(agentId)
      ? this.desktopImage
      : this.image;
  }

  async restart(agentId: string, _context?: Context) {
    await this.workspaces.get(agentId)?.stop(true, true);
  }
```

In `boot` (as Task 2 left it), ask for the bot's image instead of the default, record it in `Running`, and start the desktop from the host once the relay is up. Task 2's machine record then replaces the machine when the bot gains or loses its bot desktop:

```ts
    const image = this.imageFor(agentId);

    // ...Task 2's resume, record check, and create, unchanged...

      await sandbox!.fs().write(GUEST_DAEMON, await readFile(this.daemon));
      await run(sandbox!, `chmod 755 ${GUEST_DAEMON}`);
      relay = await startRelay(sandbox!);

      // Started here, not through pi-env: its daemon kills what it started when the connection closes.
      if (image === this.desktopImage) await run(sandbox!, DESKTOP_START);

      return {
        sandbox: sandbox!,
        relay,
        proxy,
        command: [process.execPath, BRIDGE_PATH, relay.socketPath],
        image,
      };
```

- [ ] **Step 5: Update test fakes.** In `test/coding.test.ts`, add to `DirectoryWorkspaces`:

```ts
  readonly desktop = false;

  async restart(_agentId: string, _context: Context) {}
```

- [ ] **Step 6: Run.** `bun test test/microsandbox-workspaces.test.ts test/coding.test.ts && bun run typecheck` — expected: pass.

- [ ] **Step 7: VM check.** With both images loaded:

```bash
CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev bun test test/microsandbox-workspaces.test.ts
```

Expected: the existing VM tests still pass. The desktop boot is covered in Task 8.

- [ ] **Step 8: Commit** (when the owner asks): `git add src/workspace.ts src/microsandbox-workspaces.ts test/microsandbox-workspaces.test.ts test/coding.test.ts && git commit -m "feat(workspace): boot the desktop image for desktop bots"`

## Task 5: The `computer_use` tool

Ported from Hermes Agent's `tools/computer_use/schema.py` (MIT, Nous Research) and the spike's `den/computer-use.mts`, with the three measured changes: tree-first captures with diffs, background-then-foreground delivery, no per-action approval.

**Files:** create `src/computer-use.ts`, `test/computer-use.test.ts`, `test/fixtures/scripted-guest.ts`.

**Interfaces produced:**
- `COMPUTER_USE_TOOL_NAME = "computer_use"`
- `type DesktopShell = Pick<ExecutionEnv, "exec" | "writeFile" | "readBinaryFile">`
- `computerUseTool(): ToolRegistration` — a Pi Durable tool for a job extension; it uses the job's environment (`api.env`).
- `createComputerUse(shell: DesktopShell): { run(args: ComputerUseArgs, context: Context): Promise<ComputerUseResult>; reset(): void }`
- `type ComputerUseResult = { content: (TextContent | ImageContent)[]; isError: boolean }`

- [ ] **Step 1: Write the failing tests.** Create `test/computer-use.test.ts`. The scripted guest (`test/fixtures/scripted-guest.ts`, shared with Task 6) answers `cua-driver call` commands from a queue per tool name and records every call:

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ExecutionError, FileError } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import type { DesktopShell } from "../../src/computer-use";

const jsonObject = z.record(z.string(), z.json());

export type GuestReply = z.infer<typeof jsonObject>;

export type GuestCall = { tool: string; args: GuestReply };

const CALL =
  /cua-driver call (\w+)( --screenshot-out-file (\S+))? "\$\(cat (\S+)\)"/;

/**
 * A bot desktop that runs only cua-driver and xdotool, answering each cua-driver tool from a queue of scripted replies.
 * The last reply of a queue repeats. The focused window is 101. Screenshots convert to JPEG unless `failConvert` is set.
 */
export function scriptedGuest(replies: Record<string, GuestReply[]>) {
  const files = new Map<string, Uint8Array | string>();
  const calls: GuestCall[] = [];
  const state = { failConvert: false };

  const shell: DesktopShell = {
    async writeFile(path, content) {
      files.set(path, content);

      return { ok: true, value: undefined };
    },
    async readBinaryFile(path) {
      const content = files.get(path);

      return content instanceof Uint8Array
        ? { ok: true, value: content }
        : { ok: false, error: new FileError("not_found", `no ${path}`, path) };
    },
    async exec(command, options) {
      const text = Array.isArray(command) ? command.join(" ") : String(command);

      const out = (output: string) =>
        options?.onOutput?.(output, BACKGROUND_CONTEXT, { stream: "stdout" });

      const convert = /^convert (\S+) -quality 75 (\S+)$/.exec(text);

      if (convert) {
        const [, png = "", jpg = ""] = convert;

        if (state.failConvert || !files.has(png))
          return { ok: true, value: { exitCode: 1 } };

        files.set(jpg, new Uint8Array([0xff, 0xd8, 0xff]));

        return { ok: true, value: { exitCode: 0 } };
      }

      if (text.startsWith("rm -f ")) {
        for (const path of text.slice("rm -f ".length).split(" "))
          files.delete(path);

        return { ok: true, value: { exitCode: 0 } };
      }

      if (text.includes("xdotool getactivewindow")) {
        out("101\n");

        return { ok: true, value: { exitCode: 0 } };
      }

      const match = CALL.exec(text);

      if (!match)
        return {
          ok: false,
          error: new ExecutionError("unknown", `unexpected command: ${text}`),
        };

      const [, tool = "", , screenshot, argsFile = ""] = match;

      const args = jsonObject.parse(JSON.parse(String(files.get(argsFile))));

      calls.push({ tool, args });

      const queue = replies[tool] ?? [];
      const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};

      if (screenshot) files.set(screenshot, new Uint8Array([0x89, 0x50]));

      // The tool removes its arguments file in the same command.
      files.delete(argsFile);

      out(JSON.stringify(reply));

      return { ok: true, value: { exitCode: 0 } };
    },
  };

  return { shell, calls, files, state };
}
```

The tests:

```ts
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse } from "../src/computer-use";
import { scriptedGuest } from "./fixtures/scripted-guest";

const windows = {
  windows: [
    { pid: 7, window_id: 101, app_name: "Chromium", title: "Form - Chromium" },
    { pid: 8, window_id: 202, app_name: "Tint2", title: "tint2" },
  ],
};

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

test("capture returns the focused window's tree, then a diff", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown:
          '- [0] frame "Form"\n  - [1] panel "￼￼" [actions=[doDefault,showContextMenu]]\n  - [2] entry "Name" [actions=[activate]]',
      },
      {
        snapshot_id: "s2",
        tree_diff:
          'since s1: 0 added, 1 changed\n~ [2] entry "Name" value "Ada"',
        since_status: "diff",
      },
    ],
  });

  const cu = createComputerUse(shell);

  const first = await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);
  expect(text(first)).toContain('window 101 Chromium "Form - Chromium"');
  expect(text(first)).toContain('[2] entry "Name"');
  expect(text(first)).not.toContain("￼");
  expect(text(first)).not.toContain("showContextMenu");
  expect(text(first)).not.toContain("Tint2");

  const second = await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);
  expect(text(second)).toContain('~ [2] entry "Name" value "Ada"');
  expect(
    calls.filter((c) => c.tool === "get_window_state")[1]!.args,
  ).toMatchObject({ since: "s1" });
});

test("input tries background first, then foreground when cua-driver asks for it", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
    ],
    type_text: [
      {
        code: "background_unavailable",
        escalation: { recommended: "foreground" },
      },
      { effect: "unverifiable", summary: "Typed 3 characters" },
    ],
  });

  const cu = createComputerUse(shell);

  await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await cu.run(
    { action: "type", element: 2, text: "Ada" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(text(result)).toContain("delivery: foreground");
  const typed = calls.filter((c) => c.tool === "type_text");
  expect(typed[0]!.args.delivery_mode).toBeUndefined();
  expect(typed[1]!.args).toMatchObject({
    delivery_mode: "foreground",
    element_token: "s1:2",
    session: expect.any(String),
  });
});

test("placeholder arguments count as unset", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [{ snapshot_id: "s1", tree_markdown: "- [0] frame" }],
  });

  const cu = createComputerUse(shell);

  const result = await cu.run(
    {
      action: "capture",
      window_id: 0,
      element: 0,
      coordinate: [0, 0],
      text: "",
      keys: "",
      value: "",
      seconds: 0,
      name: "",
    },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.find((c) => c.tool === "get_window_state")!.args).toMatchObject({
    window_id: 101,
  });
});

test("a refused action is an error with cua-driver's reason, and hints name only our actions", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [3] combo box "City"' },
    ],
    set_value: [
      {
        status: "refused",
        refusal: {
          code: "no_activation",
          message: 'option "Berlin" advertises no activation action',
        },
      },
    ],
    click: [
      {
        effect: "unverifiable",
        summary: "Clicked element [3]",
        hint: "Read what changed with get_window_state. Three single actions in a row: send them as one run_steps call.",
      },
    ],
  });

  const cu = createComputerUse(shell);
  await cu.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const refused = await cu.run(
    { action: "set_value", element: 3, value: "Berlin" },
    BACKGROUND_CONTEXT,
  );

  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("advertises no activation action");

  const clicked = await cu.run(
    { action: "click", element: 3 },
    BACKGROUND_CONTEXT,
  );

  expect(text(clicked)).toContain("Read what changed with capture.");
  expect(text(clicked)).not.toContain("run_steps");
});

test("vision captures attach a JPEG screenshot", async () => {
  const { shell } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown: "- [0] frame",
        screenshot_width: 1280,
        screenshot_height: 770,
      },
    ],
  });

  const cu = createComputerUse(shell);

  const result = await cu.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(
    result.content.some(
      (c) => c.type === "image" && c.mimeType === "image/jpeg",
    ),
  ).toBe(true);
  expect(text(result)).toContain("screenshot 1280x770");
});

test("acting before any capture asks for one", async () => {
  const { shell } = scriptedGuest({ list_windows: [windows] });
  const cu = createComputerUse(shell);

  const result = await cu.run(
    { action: "click", element: 4 },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(true);
  expect(text(result)).toContain("capture first");
});

test("a screenshot that fails to convert attaches no image, and no files are left behind", async () => {
  const guest = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      {
        snapshot_id: "s1",
        tree_markdown: "- [0] frame",
        screenshot_width: 1280,
        screenshot_height: 770,
      },
    ],
  });

  const tool = createComputerUse(guest.shell);

  const first = await tool.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(first.content.some((c) => c.type === "image")).toBe(true);

  guest.state.failConvert = true;

  const second = await tool.run(
    { action: "capture", mode: "vision" },
    BACKGROUND_CONTEXT,
  );

  expect(second.content.some((c) => c.type === "image")).toBe(false);
  expect([...guest.files.keys()]).toEqual([]);
});

test("set_value with an empty value clears the field", async () => {
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [
      { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
    ],
    set_value: [{ effect: "confirmed", summary: "Cleared [2]" }],
  });

  const tool = createComputerUse(shell);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);

  const result = await tool.run(
    { action: "set_value", element: 2, value: "" },
    BACKGROUND_CONTEXT,
  );

  expect(result.isError).toBe(false);
  expect(calls.find((c) => c.tool === "set_value")?.args).toMatchObject({
    value: "",
  });
});
```

- [ ] **Step 2: Run them.** `bun test test/computer-use.test.ts` — expected: FAIL, cannot resolve `../src/computer-use`.

- [ ] **Step 3: Implement `src/computer-use.ts`.**

```ts
// Ported from Hermes Agent's computer_use tool (tools/computer_use/schema.py, MIT, Nous Research). Changes, measured in
// the bot desktop spike: captures default to the accessibility tree with diff reads instead of screenshots, input
// climbs from background to foreground on its own (the bot owns its display), and there is no per-action approval.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  StringEnum,
  Type,
  type ImageContent,
  type TextContent,
} from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";

export const COMPUTER_USE_TOOL_NAME = "computer_use";

/** The part of a job's environment the tool needs. */
export type DesktopShell = Pick<
  ExecutionEnv,
  "exec" | "writeFile" | "readBinaryFile"
>;

export type ComputerUseResult = {
  content: (TextContent | ImageContent)[];
  isError: boolean;
};

const ENV_FILE = "/run/crumble-desktop.env";
const SESSION = "crumble-desktop-job";
const MAX_TREE_CHARS = 12_000;

const point = (description: string) =>
  Type.Array(Type.Integer(), { minItems: 2, maxItems: 2, description });

export const computerUseParameters = Type.Object({
  action: StringEnum(
    [
      "capture",
      "click",
      "double_click",
      "right_click",
      "drag",
      "scroll",
      "type",
      "key",
      "set_value",
      "wait",
      "list_windows",
      "focus_window",
    ],
    {
      description:
        "Which action to perform. `capture` has no side effects. Use `set_value` for text fields and select or combo boxes when the element supports it.",
    },
  ),
  mode: Type.Optional(
    StringEnum(["ax", "vision"], {
      description:
        "Capture mode. `ax` (default): accessibility tree only, as a diff after the first read. `vision`: full tree plus a screenshot.",
    }),
  ),
  full: Type.Optional(
    Type.Boolean({
      description: "capture: return the whole tree instead of a diff.",
    }),
  ),
  window_id: Type.Optional(
    Type.Integer({
      description:
        "Target window (from list_windows). Omit for the focused window.",
    }),
  ),
  element: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        "Element index [N] from the latest capture of the target window. Omit when unused.",
    }),
  ),
  coordinate: Type.Optional(
    point(
      "[x, y] in pixels of the latest vision screenshot. Only when no element index fits.",
    ),
  ),
  from_coordinate: Type.Optional(point("drag: source [x, y].")),
  to_coordinate: Type.Optional(point("drag: target [x, y].")),
  direction: Type.Optional(
    StringEnum(["up", "down", "left", "right"], {
      description: "scroll direction.",
    }),
  ),
  amount: Type.Optional(
    Type.Integer({ description: "scroll: wheel steps, default 3." }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "type: text typed at the focus, or into `element`. Typing appends; use set_value to replace.",
    }),
  ),
  keys: Type.Optional(
    Type.String({
      description:
        "key: a key or combo, such as 'return', 'escape', 'tab', 'ctrl+l'.",
    }),
  ),
  value: Type.Optional(
    Type.String({
      description:
        "set_value: the value, or the option label for a select or combo box.",
    }),
  ),
  seconds: Type.Optional(
    Type.Number({ description: "wait: seconds to pause, at most 30." }),
  ),
  capture_after: Type.Optional(
    Type.Boolean({
      description:
        "After the action, include a capture (diff) of the target window. Saves a round trip.",
    }),
  ),
});

export type ComputerUseArgs = {
  action: string;
  mode?: string;
  full?: boolean;
  window_id?: number;
  element?: number;
  coordinate?: number[];
  from_coordinate?: number[];
  to_coordinate?: number[];
  direction?: string;
  amount?: number;
  text?: string;
  keys?: string;
  value?: string;
  seconds?: number;
  name?: string;
  capture_after?: boolean;
};

const loose = <T extends z.ZodType>(schema: T) =>
  schema.optional().catch(undefined);

const window = z.object({
  pid: z.number(),
  window_id: z.number(),
  app_name: z.string(),
  title: z.string(),
});

type Window = z.infer<typeof window>;

// cua-driver reports refusals in several shapes; an error is a message or an object with a code.
const driverError = z.union([
  z.string().transform((message) => ({ code: undefined, message })),
  z.object({ code: loose(z.string()), message: loose(z.string()) }),
]);

/** A cua-driver tool result: the fields this tool reads, each dropped when its shape is unexpected. */
const driverReply = z.object({
  status: loose(z.string()),
  effect: loose(z.string()),
  code: loose(z.string()),
  summary: loose(z.string()),
  message: loose(z.string()),
  detail: loose(z.string()),
  hint: loose(z.string()),
  error: loose(driverError),
  refusal: loose(
    z.object({ code: loose(z.string()), message: loose(z.string()) }),
  ),
  escalation: loose(z.object({ recommended: loose(z.string()) })),
  snapshot_id: loose(z.string()),
  tree_markdown: loose(z.string()),
  tree_diff: loose(z.string()),
  degraded: loose(z.boolean()),
  degraded_reason: loose(z.string()),
  truncated: loose(z.boolean()),
  screenshot_width: loose(z.number()),
  screenshot_height: loose(z.number()),
  windows: loose(z.array(window)),
});

type DriverReply = z.infer<typeof driverReply>;

/** Arguments for a cua-driver tool. */
type DriverArgs = Record<string, string | number | boolean | string[]>;

function parseReply(output: string): DriverReply {
  try {
    const parsed = driverReply.safeParse(JSON.parse(output));

    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: cua-driver printed an error.
  }

  return {
    error: {
      code: undefined,
      message: output.trim().slice(0, 500) || "cua-driver returned nothing",
    },
  };
}

// Chromium names container panels with U+FFFC placeholders and gives every node showContextMenu: tokens, no meaning.
const compact = (tree: string) =>
  tree.replace(/￼+/g, "").replace(/,showContextMenu|showContextMenu,?/g, "");

// cua-driver's hints sometimes name its own tools (run_steps, get_window_state); keep only advice that fits ours.
const cleanHint = (hint = "") =>
  hint
    .replace(/\s*Three single actions in a row:.*$/s, "")
    .replace(/get_window_state/g, "capture")
    .trim();

const codeOf = (reply: DriverReply) =>
  reply.code ?? reply.refusal?.code ?? reply.error?.code;

const refusalOf = (reply: DriverReply) => {
  const code = codeOf(reply);

  const refused =
    reply.status === "refused" ||
    reply.effect === "refused" ||
    reply.effect === "none" ||
    reply.error !== undefined ||
    Boolean(code?.endsWith("_unavailable"));

  return refused ? (code ?? "refused") : undefined;
};

const wantsForeground = (reply: DriverReply) =>
  Boolean(codeOf(reply)?.endsWith("_unavailable")) ||
  reply.escalation?.recommended === "foreground";

const messageOf = (reply: DriverReply) =>
  [
    reply.summary,
    reply.refusal?.message,
    reply.message,
    reply.detail,
    reply.error?.message,
  ].find(Boolean);

/** Normalizes placeholder arguments: some models (gpt-6-luna) fill every optional field with 0, "", or [0, 0]. */
function normalize(raw: ComputerUseArgs): ComputerUseArgs {
  const args = { ...raw };
  const unsetPoint = (p?: number[]) => !p || (p[0] === 0 && p[1] === 0);

  if (!args.window_id) delete args.window_id;

  // Element [0] is the window frame itself, never a useful target.
  if (!args.element) delete args.element;

  if (unsetPoint(args.coordinate)) delete args.coordinate;

  if (unsetPoint(args.from_coordinate)) delete args.from_coordinate;

  if (unsetPoint(args.to_coordinate)) delete args.to_coordinate;

  if (!args.amount) delete args.amount;

  if (!args.seconds) delete args.seconds;

  for (const key of ["keys", "name", "mode"] as const)
    if (args[key] === "") delete args[key];

  // An empty set_value clears a field.
  if (args.value === "" && args.action !== "set_value") delete args.value;

  if (args.text === "" && args.action !== "type") delete args.text;

  return args;
}

type Acted = { reply: DriverReply; route: "background" | "foreground" };

/** An action the tool refused before reaching cua-driver, such as a missing argument. */
type Invalid = { invalid: string };

type Pointer = { element_token: string } | { x: number; y: number };

export function createComputerUse(shell: DesktopShell) {
  // Latest snapshot per window: element tokens are `${snapshot}:${N}`, and the next capture diffs against it.
  const snapshots = new Map<number, string>();

  async function sh(command: string, context: Context) {
    let output = "";

    const result = await shell.exec(
      `. ${ENV_FILE}; ${command}`,
      { onOutput: (text) => (output += text) },
      context,
    );

    if (!result.ok) throw result.error;

    return output;
  }

  async function driver(
    tool: string,
    args: DriverArgs,
    context: Context,
    screenshot = false,
  ) {
    // Unique per call: a file left by another job's call can never stand in for this one's.
    const id = randomUUID();
    const argsFile = `/tmp/computer-use-${id}.json`;
    const png = `/tmp/computer-use-${id}.png`;
    const jpg = `/tmp/computer-use-${id}.jpg`;

    const written = await shell.writeFile(
      argsFile,
      JSON.stringify({ session: SESSION, ...args }),
      context,
    );

    if (!written.ok) throw written.error;

    const shot = screenshot ? ` --screenshot-out-file ${png}` : "";

    const reply = parseReply(
      await sh(
        `cua-driver call ${tool}${shot} "$(cat ${argsFile})"; rm -f ${argsFile}`,
        context,
      ),
    );

    if (!screenshot) return { reply };

    try {
      const converted = await shell.exec(
        `convert ${png} -quality 75 ${jpg}`,
        undefined,
        context,
      );

      if (!converted.ok || converted.value.exitCode !== 0) return { reply };

      const image = await shell.readBinaryFile(jpg, context);

      return {
        reply,
        image: image.ok
          ? Buffer.from(image.value).toString("base64")
          : undefined,
      };
    } finally {
      await shell.exec(`rm -f ${png} ${jpg}`, undefined, context);
    }
  }

  async function windows(context: Context) {
    const { reply } = await driver("list_windows", {}, context);

    return (reply.windows ?? []).filter((each) => each.app_name !== "Tint2");
  }

  async function target(windowId: number | undefined, context: Context) {
    const list = await windows(context);

    if (windowId !== undefined) {
      const found = list.find((each) => each.window_id === windowId);

      if (!found) throw new Error(`no window ${windowId}; call list_windows`);

      return found;
    }

    const active = Number(
      (await sh("xdotool getactivewindow 2>/dev/null", context)).trim(),
    );

    const found = list.find((each) => each.window_id === active) ?? list[0];

    if (!found) throw new Error("no windows are open");

    return found;
  }

  // Background first, then foreground: GTK apps need background accessibility actions, Chromium foreground keys.
  async function act(
    tool: string,
    args: DriverArgs,
    context: Context,
  ): Promise<Acted> {
    const background = (await driver(tool, args, context)).reply;

    if (!refusalOf(background) || !wantsForeground(background))
      return { reply: background, route: "background" };

    const foreground = (
      await driver(tool, { ...args, delivery_mode: "foreground" }, context)
    ).reply;

    return { reply: foreground, route: "foreground" };
  }

  function verdict({ reply, route }: Acted) {
    const code = refusalOf(reply);
    const hint = cleanHint(reply.hint);

    const parts = [
      code ? `REFUSED (${code})` : `effect: ${reply.effect ?? "ok"}`,
      `delivery: ${route}`,
      messageOf(reply),
      hint ? `hint: ${hint}` : undefined,
    ];

    return { text: parts.filter(Boolean).join(" | "), error: Boolean(code) };
  }

  async function capture(
    target: Window,
    mode: string,
    full: boolean,
    context: Context,
  ): Promise<(TextContent | ImageContent)[]> {
    const since =
      mode === "ax" && !full ? snapshots.get(target.window_id) : undefined;

    const vision = mode === "vision";

    const { reply, image } = await driver(
      "get_window_state",
      {
        pid: target.pid,
        window_id: target.window_id,
        include_screenshot: vision,
        ...(since && { since }),
      },
      context,
      vision,
    );

    if (refusalOf(reply))
      return [
        {
          type: "text",
          text: `capture failed: ${messageOf(reply) ?? codeOf(reply) ?? "unknown error"}`,
        },
      ];

    if (reply.snapshot_id) snapshots.set(target.window_id, reply.snapshot_id);

    const others = (await windows(context))
      .filter((each) => each.window_id !== target.window_id)
      .map((each) => `${each.window_id} ${each.app_name} "${each.title}"`);

    let tree = compact(reply.tree_diff ?? reply.tree_markdown ?? "");

    if (tree.length > MAX_TREE_CHARS)
      tree = `${tree.slice(0, MAX_TREE_CHARS)}\n[tree cut at ${MAX_TREE_CHARS} characters; scroll or capture a smaller window]`;

    const header = [
      `window ${target.window_id} ${target.app_name} "${target.title}" (snapshot ${reply.snapshot_id ?? "none"}${since ? `, changes since ${since}` : ""})`,
      others.length ? `other windows: ${others.join("; ")}` : undefined,
      reply.degraded ? `degraded: ${reply.degraded_reason ?? ""}` : undefined,
      reply.truncated
        ? "tree truncated: capture with full=true or narrow the window"
        : undefined,
    ]
      .filter(Boolean)
      .join("\n");

    const content: (TextContent | ImageContent)[] = [
      { type: "text", text: `${header}\n${tree}` },
    ];

    if (image)
      content.push(
        {
          type: "text",
          text: `screenshot ${reply.screenshot_width ?? "?"}x${reply.screenshot_height ?? "?"}, coordinates are pixels of this image`,
        },
        { type: "image", data: image, mimeType: "image/jpeg" },
      );

    return content;
  }

  const tokenFor = (target: Window, element: number) => {
    const snapshot = snapshots.get(target.window_id);

    if (!snapshot)
      throw new Error("no capture of this window yet; capture first");

    return `${snapshot}:${element}`;
  };

  const pointer = (
    target: Window,
    args: ComputerUseArgs,
  ): Pointer | undefined => {
    if (args.element !== undefined)
      return { element_token: tokenFor(target, args.element) };

    const [x, y] = args.coordinate ?? [];

    return x === undefined || y === undefined ? undefined : { x, y };
  };

  async function perform(
    args: ComputerUseArgs,
    target: Window,
    context: Context,
  ): Promise<Acted | Invalid> {
    const base = { pid: target.pid, window_id: target.window_id };

    switch (args.action) {
      case "focus_window":
        return {
          reply: (await driver("bring_to_front", base, context)).reply,
          route: "foreground",
        };
      case "click":
      case "double_click":
      case "right_click": {
        const at = pointer(target, args);

        if (!at)
          return { invalid: `${args.action} needs element or coordinate` };

        return act(args.action, { ...base, ...at }, context);
      }

      case "drag": {
        const [fromX, fromY] = args.from_coordinate ?? [];
        const [toX, toY] = args.to_coordinate ?? [];

        if (
          fromX === undefined ||
          fromY === undefined ||
          toX === undefined ||
          toY === undefined
        )
          return { invalid: "drag needs from_coordinate and to_coordinate" };

        return act(
          "drag",
          { ...base, from_x: fromX, from_y: fromY, to_x: toX, to_y: toY },
          context,
        );
      }

      case "scroll":
        return act(
          "scroll",
          {
            ...base,
            ...pointer(target, args),
            direction: args.direction ?? "down",
            amount: args.amount ?? 3,
          },
          context,
        );
      case "type":
        if (args.text === undefined) return { invalid: "type needs text" };

        return act(
          "type_text",
          {
            ...base,
            ...(args.element !== undefined && {
              element_token: tokenFor(target, args.element),
            }),
            text: args.text,
          },
          context,
        );
      case "key": {
        if (!args.keys) return { invalid: "key needs keys" };

        const keys = args.keys
          .split("+")
          .map((key) => key.trim().toLowerCase());

        return keys.length > 1
          ? act("hotkey", { ...base, keys }, context)
          : act("press_key", { ...base, key: keys[0] ?? "" }, context);
      }

      case "set_value":
        if (args.element === undefined || args.value === undefined)
          return { invalid: "set_value needs element and value" };

        return act(
          "set_value",
          {
            ...base,
            element_token: tokenFor(target, args.element),
            value: args.value,
          },
          context,
        );
      default:
        return { invalid: `unknown action ${args.action}` };
    }
  }

  async function run(
    raw: ComputerUseArgs,
    context: Context,
  ): Promise<ComputerUseResult> {
    const args = normalize(raw);

    const text = (value: string, isError = false): ComputerUseResult => ({
      content: [{ type: "text", text: value }],
      isError,
    });

    try {
      if (args.action === "list_windows")
        return text(
          (await windows(context))
            .map((each) => `${each.window_id} ${each.app_name} "${each.title}"`)
            .join("\n") || "no windows",
        );

      if (args.action === "wait") {
        const seconds = Math.min(Math.max(args.seconds ?? 1, 0), 30);

        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

        return text(`waited ${seconds}s`);
      }

      const window = await target(args.window_id, context);

      if (args.action === "capture")
        return {
          content: await capture(
            window,
            args.mode ?? "ax",
            args.full === true,
            context,
          ),
          isError: false,
        };

      const acted = await perform(args, window, context);

      if ("invalid" in acted) return text(acted.invalid, true);

      const { text: summary, error } = verdict(acted);

      const after =
        args.capture_after && !error
          ? await capture(
              await target(args.window_id, context),
              "ax",
              false,
              context,
            )
          : [];

      return {
        content: [{ type: "text", text: summary }, ...after],
        isError: error,
      };
    } catch (error) {
      return text(
        `error: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  return { run, reset: () => snapshots.clear() };
}

/** The tool for a desktop job, over the job's environment. One instance per job conversation keeps its snapshots. */
export function computerUseTool() {
  const instances = new Map<string, ReturnType<typeof createComputerUse>>();

  return defineTool({
    name: COMPUTER_USE_TOOL_NAME,
    description:
      "Operate the bot desktop (Openbox, Chromium, other X11 apps) through its accessibility tree, mouse, and keyboard. " +
      "Workflow: action='capture' returns the focused window's accessibility tree; every actionable element is tagged [N]. " +
      "Act on elements by index (element=N), which is more reliable than coordinates. Later captures of the same window list only what changed " +
      "(+ added, ~ changed, - removed) and keep earlier [N] unless a 'reindexed' line says otherwise. Use mode='vision' for a screenshot when the " +
      "tree is missing something; coordinates are pixels of that screenshot. Each result carries a verdict: never repeat confirmed input; capture " +
      "to check an unverified one before retrying.",
    parameters: computerUseParameters,
    callers: ["model"],
    // Input already sent cannot be taken back; after a crash the job captures and decides.
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const env = api.env;

      if (!env)
        return {
          output: [
            {
              type: "text" as const,
              text: "No bot desktop is available here.",
            },
          ],
          isError: true,
        };

      const key = String(api.conversationId);
      let computer = instances.get(key);

      if (!computer) {
        computer = createComputerUse(env);
        instances.set(key, computer);
      }

      const result = await computer.run(args, callContext);

      return { output: result.content, isError: result.isError };
    },
  });
}
```

cua-driver's replies are parsed once with a Zod schema (`driverReply`); each field is dropped when its shape is unexpected, as the repository's lint rules require parsing at the boundary.

- [ ] **Step 4: Run.** `bun test test/computer-use.test.ts && bun run typecheck` — expected: pass.

- [ ] **Step 5: Commit** (when the owner asks): `git add src/computer-use.ts test/computer-use.test.ts && git commit -m "feat(desktop): add the computer_use tool"`

## Task 6: Desktop jobs

**Files:** create `src/desktop.ts`, `test/desktop.test.ts`; modify `src/domain.ts` (`agentInput`, lines 3-45), `src/store.ts` (migration after line 158, `agent()` at line 282, `createAgent` at line 313, `updateAgent` at line 342), `src/transcript.ts` (line 15 import, lines 150-155 preview), `test/store.test.ts`.

**Interfaces consumed:** `defineJobKind` (Task 1), `Workspaces` (Task 4), `computerUseTool` (Task 5).

**Interfaces produced:**
- `DESKTOP_TOOL_NAME = "desktop"`
- As built: `desktopExtensions(agent)` takes no workspaces, since `computer_use` uses the job's `api.env`; `desktopModel` is also added to `agentResponse`, with contract 1.4.0 and a regenerated `openapi/openapi.json` in this task, because `bun run check` fails on contract drift otherwise.
- `desktopJobOf(message): string | undefined`, `desktopJobs(harness, chatId): Promise<JobInfo[]>`, `desktopEnv(workspaces, agentId, target, context)`, `desktopExtensions(agent: Pick<Agent, "id" | "desktopModel">): JobExtensions`
- `agentInput.desktopModel?: { provider: string; model: string }`

- [ ] **Step 1: Write the failing store test.** Append to `test/store.test.ts`:

```ts
test("an agent keeps its desktop job model", () => {
  const dir = make();
  const store = new Store(dir);
  const agent = store.createAgent({ ...input, desktopModel: { provider: "opencode-go", model: "gpt-6-luna" } });

  expect(store.getAgent(agent.id)?.desktopModel).toEqual({ provider: "opencode-go", model: "gpt-6-luna" });
  expect(store.updateAgent(agent.id, { desktopModel: undefined })?.desktopModel).toBeUndefined();
  store.close();
});
```

Use the file's existing `make()` and `input` helpers.

- [ ] **Step 2: Run.** `bun test test/store.test.ts` — expected: FAIL, `desktopModel` is not a known key.

- [ ] **Step 3: Add `desktopModel`.** In `src/domain.ts`, inside `agentInput` after `inference`:

```ts
  /** The model for this bot's desktop jobs; unset, they use the bot's own model. */
  desktopModel: z
    .object({
      provider: z.string().trim().min(1).max(80).regex(/^[a-z0-9-]+$/),
      model: z.string().trim().min(1).max(200),
    })
    .optional(),
```

In `src/store.ts`:

```ts
    // migrate(), after the shared_skills column:
    if (!agentCols.some((c) => c.name === "desktop_model"))
      this.db.exec("ALTER TABLE agents ADD COLUMN desktop_model TEXT");

    // agent(r), after inference:
      ...(r.desktop_model ? { desktopModel: JSON.parse(r.desktop_model) } : {}),
```

Add `desktop_model` to the `INSERT` column list and values (`input.desktopModel ? this.j(input.desktopModel) : null`) and to the `UPDATE` statement (`desktop_model=?` with `x.desktopModel ? this.j(x.desktopModel) : null`).

- [ ] **Step 4: Run.** `bun test test/store.test.ts` — expected: pass.

- [ ] **Step 5: Write the desktop job tests.** Create `test/desktop.test.ts`. A fake workspace serves the scripted guest from Task 5 as the job's environment; one faux model plays bot and job, told apart by the offered tools:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context } from "@earendil-works/chord";
import { createModels, type Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { desktopEnv, desktopExtensions } from "../src/desktop";
import type { Agent } from "../src/domain";
import { AgentRuntime } from "../src/runtime";
import { Store } from "../src/store";
import { latestMessagePreview } from "../src/transcript";
import type { Workspaces } from "../src/workspace";
import { scriptedGuest, type GuestCall } from "./fixtures/scripted-guest";

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** The workspace is a scripted bot desktop: cua-driver answers from replies, nothing runs. */
class GuestWorkspaces implements Workspaces {
  readonly desktop = true;
  readonly calls: GuestCall[];
  private readonly guest: ReturnType<typeof scriptedGuest>;

  constructor(readonly dir: string) {
    this.guest = scriptedGuest({
      list_windows: [
        {
          windows: [
            {
              pid: 7,
              window_id: 101,
              app_name: "Chromium",
              title: "Form - Chromium",
            },
          ],
        },
      ],
      get_window_state: [
        { snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' },
      ],
      set_value: [{ effect: "confirmed", summary: "Set value of [2]" }],
    });
    this.calls = this.guest.calls;
  }

  env(_agentId: string) {
    return Object.assign(new NodeExecutionEnv({ cwd: this.dir }), {
      exec: this.guest.shell.exec,
      writeFile: this.guest.shell.writeFile,
      readBinaryFile: this.guest.shell.readBinaryFile,
    });
  }

  async sync(_agentId: string, _context: Context) {}

  async restart(_agentId: string, _context: Context) {}

  async close(_context: Context) {}
}

const textOf = (message: Message) =>
  (Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }]
  )
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

type Role = "bot" | "job";

/** One scripted model plays the bot and its desktop job; the tools it was offered tell them apart. */
function script(
  offered: Map<Role, string[]>,
  models: Map<Role, string>,
): FauxResponseFactory {
  return async (context, _options, _state, model) => {
    const tools = context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    );

    const role: Role = tools.includes("computer_use") ? "job" : "bot";

    offered.set(role, tools);
    models.set(role, model.id);

    const last = context.messages.findLast(
      (message) => message.role !== "system",
    )!;

    const call = (name: string, args: Record<string, string | number>) =>
      fauxAssistantMessage(fauxToolCall(name, args), {
        stopReason: "toolUse",
      });

    if (role === "job") {
      if (last.role === "user")
        return call("computer_use", { action: "capture" });

      if (last.role === "toolResult" && textOf(last).includes("window 101"))
        return call("computer_use", {
          action: "set_value",
          element: 2,
          value: "Ada",
        });

      return fauxAssistantMessage([fauxText("Filled in Ada.")]);
    }

    if (textOf(last).startsWith("[desktop job"))
      return fauxAssistantMessage([fauxText("The form is filled.")]);

    return call("desktop", {
      action: "start",
      name: "form",
      message: "Fill the form with Ada.",
    });
  };
}

async function open(desktopModel?: Agent["desktopModel"]) {
  const dir = mkdtempSync(join(tmpdir(), "bot-desktop-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  cleanups.push(() => store.close());

  const agent = store.createAgent({
    name: "Desk",
    avatar: "bot",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: ["desktop"],
    skills: [],
    mcpServers: [],
    delegates: [],
    ...(desktopModel && { desktopModel }),
  });

  const offered = new Map<Role, string[]>();
  const used = new Map<Role, string>();

  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "chat" }, { id: "desk" }],
  });

  faux.setResponses(Array.from({ length: 40 }, () => script(offered, used)));
  const models = createModels();
  models.setProvider(faux.provider);

  const workspaces = new GuestWorkspaces(dir);
  const extensions = desktopExtensions(agent);

  const runtime = new AgentRuntime(dir, {
    models,
    extensions: () => extensions.chat,
    taskExtensions: () => extensions.job,
    env: (agentId, target, context) =>
      desktopEnv(workspaces, agentId, target, context),
  });

  cleanups.push(() => runtime.close());

  const chat = await runtime.openChat(agent);

  await runtime.submit(agent, chat, "Fill in the form", "req-1");

  await until(async () =>
    (await runtime.snapshot(agent, chat)).messages.some(
      (message) => message.content === "The form is filled.",
    ),
  );

  return { runtime, agent, chat, offered, used, calls: workspaces.calls };
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500 && !(await check()); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));

  expect(await check()).toBe(true);
}

test("a desktop job operates the bot desktop and reports to the bot's chat", async () => {
  const { runtime, agent, chat, offered, calls } = await open();
  const messages = (await runtime.snapshot(agent, chat)).messages;

  // The job has exactly computer_use: no shell, memory, delegation, or jobs. The chat never gets computer_use.
  expect(offered.get("job")).toEqual(["computer_use"]);
  expect(offered.get("bot")).toEqual(["desktop"]);

  const report = messages.find((message) => message.origin?.kind === "desktop");

  expect(report?.content).toBe("Filled in Ada.");
  expect(report?.origin?.name).toBe("form");

  const card = messages.find((message) => message.toolName === "desktop")!;

  expect(latestMessagePreview([card])).toBe("Desktop job form");

  // The job's set_value went to the element of the snapshot it captured.
  expect(calls.find((each) => each.tool === "set_value")?.args).toMatchObject({
    element_token: "s1:2",
    value: "Ada",
  });
});

test("desktop jobs run on the bot's desktop model", async () => {
  const { used } = await open({ provider: "faux", model: "desk" });

  expect(used.get("bot")).toBe("chat");
  expect(used.get("job")).toBe("desk");
});

test("without a desktop model, desktop jobs use the bot's model", async () => {
  const { used } = await open();

  expect(used.get("job")).toBe("chat");
});
```

- [ ] **Step 6: Run.** `bun test test/desktop.test.ts` — expected: FAIL, cannot resolve `../src/desktop`.

- [ ] **Step 7: Implement `src/desktop.ts`.**

```ts
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type ConversationId,
  type EnvTarget,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { computerUseTool } from "./computer-use";
import type { Agent } from "./domain";
import { defineJobKind, type JobExtensions } from "./jobs";
import type { Workspaces } from "./workspace";

export const DESKTOP_TOOL_NAME = "desktop";

const desktop = defineJobKind({
  kind: "desktop",
  toolName: DESKTOP_TOOL_NAME,
  label: "desktop job",
  exclusive: true,
  description:
    "Run desktop jobs: background agents that operate your bot desktop, a Linux desktop with Chromium and other apps in your workspace, with mouse and keyboard. " +
    "Use them for websites and apps that need a browser or a screen: pages without an API, forms, logged-in accounts. Browser logins and files persist between jobs. " +
    "Actions: start (name, message: the full task, since the job knows nothing else), send (name, message; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "One desktop job works at a time; others wait. Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "A job asks when it needs the owner, such as for a login or a payment; pass the owner's answer on with send. Jobs keep working after your turn ends; their final answer arrives later as a message from the job. Do not wait or poll for it.",
  instructions: [
    "You are a desktop job for another bot. You operate a Linux desktop: Openbox, Chromium maximized, a panel at the bottom. Use the computer_use tool.",
    "Start with action='capture'. Prefer element indices and set_value over coordinates; use mode='vision' only when the tree lacks what you need.",
    "To open a URL in Chromium: key 'ctrl+l' (selects the address bar), type the URL, key 'return'. Typing into a field appends to its text; use set_value to replace it.",
    "Use capture_after=true on actions whose effect you need to check. Omit parameters you don't use.",
    "If something is the owner's to do or decide (a login, a captcha, a payment, a choice the task didn't settle), stop and say exactly what you need instead of guessing.",
    "Finish with a short report: what you did, what you saw, and what is left.",
  ].join(" "),
});

/** The job a successful `desktop` result shows as a card; a listing or a failed call shows none. */
export const desktopJobOf = desktop.jobOf;

export const desktopJobs = (harness: Harness, chatId: ConversationId) =>
  desktop.list(harness, chatId);

export const desktopEnv = (
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
): Promise<ExecutionEnv | undefined> =>
  desktop.env(workspaces, agentId, target, context);

/** Lets a bot run desktop jobs: child conversations with the computer_use tool on its bot desktop. */
export function desktopExtensions(
  agent: Pick<Agent, "id" | "desktopModel">,
): JobExtensions {
  const job = defineExtension({
    name: "desktop-job",
    tools: [computerUseTool()],
  });

  return desktop.extensions({
    agentId: agent.id,
    job,
    ...(agent.desktopModel && {
      model: {
        provider: agent.desktopModel.provider,
        modelId: agent.desktopModel.model,
      },
    }),
  });
}
```

In `src/transcript.ts`, import `desktopJobOf` from `./desktop` and extend the preview (lines 150-155):

```ts
    const job = codingJobOf(message);

    if (job) return `Coding job ${job}`;
    const desktopJob = desktopJobOf(message);

    if (desktopJob) return `Desktop job ${desktopJob}`;
```

- [ ] **Step 8: Run.** `bun test test/desktop.test.ts test/coding.test.ts test/jobs.test.ts && bun run typecheck` — expected: pass. If the desktop model is not found, `AgentRuntime.configure` (`src/runtime.ts` lines 471-473) refreshes the catalog only for the bot's provider; add the same refresh for `agent.desktopModel?.provider` there.

- [ ] **Step 9: Commit** (when the owner asks): `git add src/desktop.ts src/domain.ts src/store.ts src/transcript.ts src/runtime.ts test/desktop.test.ts test/store.test.ts test/computer-use.test.ts test/fixtures/scripted-guest.ts && git commit -m "feat(desktop): add desktop jobs"`

## Task 7: Server wiring and API

**Files:** modify `src/server.ts` (lines 28-30 imports, 122-158 wiring, 234 capability), `src/api-responses.ts` (capabilities at line 17, `agentResponse` at line 36, after `codingJobsResponse` at line 151), `src/api-contract.ts` (after `codingJobHistory` at line 313, version at line 746), `src/api.ts` (options at line 72, capabilities at line 125, routes after line 252, `updateAgent` at lines 196-207), `src/runtime.ts` (after `codingJobHistory`, line 973), `src/service.ts` (after line 313), `openapi/openapi.json`, `test/api.test.ts`.

**Interfaces produced:**
- `GET /v1/capabilities` → `{ coding: boolean, desktop: boolean }`
- `GET /v1/agents/{id}/desktop-jobs` → `DesktopJobs { jobs: DesktopJob[] }`, `GET /v1/agents/{id}/desktop-jobs/{name}/history` → `TranscriptPage`
- `Agent.desktopModel?: { provider, model }` in requests and responses
- `AgentRuntime.desktopJobs(agent)`, `AgentRuntime.desktopJobHistory(agent, name, options)`, `CrumbleService.desktopJobs(agentId)`, `CrumbleService.desktopJobHistory(agentId, name, options)`
- `createAPI` option `desktop?: boolean` and `restartWorkspace?: (agentId: string) => Promise<void>`

- [ ] **Step 1: Write the failing API tests.** Append to `test/api.test.ts`, following its existing app setup helper:

```ts
test("capabilities report desktop availability", async () => {
  const { app, token } = setup({ coding: true, desktop: true });
  const res = await app.request("/v1/capabilities", { headers: { authorization: `Bearer ${token}` } });
  expect(await res.json()).toEqual({ coding: true, desktop: true });
});

test("agents keep a desktop model", async () => {
  const { app, token } = setup({});
  const res = await app.request("/v1/agents", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Desk", desktopModel: { provider: "opencode-go", model: "gpt-6-luna" } }),
  });
  expect((await res.json()).desktopModel).toEqual({ provider: "opencode-go", model: "gpt-6-luna" });
});

test("turning the desktop tool on or off restarts the bot's workspace", async () => {
  const restarted: string[] = [];
  const { app, token, store } = setup({ restartWorkspace: async (id) => void restarted.push(id) });
  const agent = store.createAgent({ name: "Desk", tools: [] });
  const patch = (tools: string[]) =>
    app.request(`/v1/agents/${agent.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tools }),
    });

  await patch(["desktop"]);
  await patch(["desktop", "memory"]);
  await patch(["memory"]);

  expect(restarted).toEqual([agent.id, agent.id]);
});

test("desktop jobs list is empty for a bot without jobs", async () => {
  const { app, token, store } = setup({});
  const agent = store.createAgent({ name: "Desk" });
  const res = await app.request(`/v1/agents/${agent.id}/desktop-jobs`, { headers: { authorization: `Bearer ${token}` } });
  expect(await res.json()).toEqual({ jobs: [] });
});
```

Adapt `setup` to the helper `test/api.test.ts` already has; extend it to pass the new `createAPI` options.

- [ ] **Step 2: Run.** `bun test test/api.test.ts` — expected: FAIL on the four new tests.

- [ ] **Step 3: Responses and contract.** In `src/api-responses.ts`:

```ts
export const capabilitiesResponse = z
  .object({
    coding: z.boolean().openapi({ description: "Whether bots can be given the coding tool on this server." }),
    desktop: z.boolean().openapi({ description: "Whether bots can be given the desktop tool (a bot desktop) on this server." }),
  })
  .openapi("Capabilities");

// in agentResponse, after inference:
    desktopModel: z.object({ provider: z.string(), model: z.string() }).optional(),

export const desktopJobsResponse = z
  .object({
    jobs: z
      .array(
        z
          .object({ name: z.string(), conversationId: z.string(), status: z.enum(["working", "idle"]) })
          .openapi("DesktopJob"),
      )
      .openapi({ description: "Oldest job first." }),
  })
  .openapi("DesktopJobs");
```

In `src/api-contract.ts`, after `codingJobHistory`:

```ts
  desktopJobs: define({
    method: "get",
    path: "/v1/agents/{id}/desktop-jobs",
    operationId: "listDesktopJobs",
    request: { params: id },
    responses: { 200: json(response.desktopJobsResponse) },
  }),
  desktopJobHistory: define({
    method: "get",
    path: "/v1/agents/{id}/desktop-jobs/{name}/history",
    operationId: "getDesktopJobHistory",
    request: { params: id.extend({ name: z.string() }), query: historyInput },
    responses: { 200: json(response.historyResponse) },
  }),
```

(Task 6 already set `version: "1.4.0"`.)

- [ ] **Step 4: Runtime and service.** In `src/runtime.ts`, import `desktopJobs` from `./desktop` and add after `codingJobHistory`:

```ts
  /** The desktop jobs the bot started from its chat, oldest first. */
  async desktopJobs(agent: Agent) {
    const { harness } = await this.open(agent);
    const root = await harness.root(BACKGROUND_CONTEXT);

    return (await desktopJobs(harness, root.id)).map((job) => ({
      name: job.name,
      conversationId: conversationReference(agent.id, Number(job.conversationId)),
      status: job.status,
    }));
  }

  /** One desktop job's transcript, paged like the chat's. */
  async desktopJobHistory(agent: Agent, name: string, options: HistoryOptions = {}) {
    const { harness } = await this.open(agent);
    const root = await harness.root(BACKGROUND_CONTEXT);
    const job = (await desktopJobs(harness, root.id)).find((each) => each.name === name);

    if (!job) throw new AppError(404, "Desktop job not found");

    return this.visible(harness, options, () =>
      readConversationTranscript(harness, agent.id, job.conversationId, options),
    );
  }
```

In `src/service.ts`, after `codingJobHistory`:

```ts
  async desktopJobs(agentId: string) {
    return this.runtime.desktopJobs(this.agent(agentId));
  }

  async desktopJobHistory(agentId: string, name: string, options: HistoryOptions = {}) {
    return this.runtime.desktopJobHistory(this.agent(agentId), name, options);
  }
```

Match `codingJobHistory`'s exact parameter types in `service.ts` (lines 307-313).

- [ ] **Step 5: API handlers.** In `src/api.ts`, extend the options type next to `coding`:

```ts
    /** Whether the server can give bots the desktop tool. */
    desktop?: boolean;
    /** Restarts a bot's workspace so it boots the image its tools need now. */
    restartWorkspace?: (agentId: string) => Promise<void>;
```

Capabilities: `c.json({ coding: options.coding === true, desktop: options.desktop === true }, 200)`.

Routes, after the coding job routes:

```ts
  register(routes.desktopJobs, async (c) =>
    c.json({ jobs: await service.desktopJobs(c.req.param("id")) }, 200),
  );
  register(routes.desktopJobHistory, async (c) =>
    c.json(await service.desktopJobHistory(c.req.param("id"), c.req.param("name"), historyOptions(c)), 200),
  );
```

Use the same query parsing the `codingJobHistory` handler uses (lines 247-252) instead of `historyOptions(c)` if that helper does not exist.

In `updateAgent`, before the return:

```ts
    // The desktop tool picks the workspace image; a bot that gains or loses it needs a fresh machine.
    if (old.tools.includes("desktop") !== input.tools.includes("desktop"))
      await options.restartWorkspace?.(old.id);
```

- [ ] **Step 6: Server wiring.** In `src/server.ts`:

```ts
import { desktopEnv, desktopExtensions, DESKTOP_TOOL_NAME } from "./desktop";

    const workspaces =
      options.workspaces ??
      microsandboxWorkspacesFromEnv(process.env, {
        wantsDesktop: (agentId) =>
          store.getAgent(agentId)?.tools.includes(DESKTOP_TOOL_NAME) === true,
      });

    const desktop = (agent: Agent) =>
      workspaces?.desktop && agent.tools.includes(DESKTOP_TOOL_NAME)
        ? desktopExtensions(agent, workspaces)
        : { chat: [], job: [] };
```

Add `...desktop(agent).chat` to `extensions` after `...coding(agent).chat`; set `taskExtensions: (agent) => [...coding(agent).job, ...desktop(agent).job]`; change `env` to:

```ts
      env: async (agentId, target, context) =>
        workspaces
          ? ((await codingEnv(workspaces, agentId, target, context)) ??
            (await desktopEnv(workspaces, agentId, target, context)))
          : undefined,
```

Pass `desktop: workspaces?.desktop === true` and `restartWorkspace: (agentId) => workspaces?.restart(agentId, BACKGROUND_CONTEXT) ?? Promise.resolve()` to `createAPI`.

Group turns: add `"desktop"` and `"desktop-job"` to `GROUP_EXCLUDED_EXTENSIONS` in `src/group-turns.ts`, so group turns cannot start desktop jobs, matching coding (feature 0002, Out of scope).

- [ ] **Step 7: Regenerate and run.** `bun run openapi:generate && bun run check` — expected: pass; `openapi/openapi.json` gains the two routes, `DesktopJob`, `DesktopJobs`, `desktopModel`, and `desktop` on `Capabilities`.

- [ ] **Step 8: Docs.** In `docs/architecture.md`, after "Coding jobs", add a "Desktop jobs" section: the generic job kind in `jobs.ts`; the `desktop` tool and its exclusive reporter; the `desktop-job` extension with only `computer_use`; `desktopEnv`; the desktop image and host-side session start; `desktopModel`; the restart on tool change. In `CHANGELOG.md` under Unreleased, add:

  - "Add desktop jobs. A bot with the `desktop` tool gets a bot desktop in its workspace: Openbox, tint2, and Chromium, driven by cua-driver. Desktop jobs operate it through the accessibility tree, mouse, and keyboard with the `computer_use` tool, one job at a time, on the bot's `desktopModel` or its own model. They have no shell, memory, delegation, scheduling, or integrations. Set `CRUMBLE_WORKSPACE_DESKTOP_IMAGE` to the `desktop` target of `workspace-image/Dockerfile` to enable them."
  - "Add `GET /v1/agents/{id}/desktop-jobs`, `GET /v1/agents/{id}/desktop-jobs/{name}/history`, the `desktop` capability, and the agent `desktopModel` field. Contract 1.4.0."
  - "Changing whether a bot has the `desktop` tool restarts its workspace machine."

- [ ] **Step 9: Commit** (when the owner asks): `git add src/server.ts src/api.ts src/api-contract.ts src/api-responses.ts src/runtime.ts src/service.ts openapi/openapi.json test/api.test.ts docs/architecture.md CHANGELOG.md && git commit -m "feat(desktop): serve desktop jobs over the API"`

## Task 8: Local VM acceptance tests

Covers the milestone's acceptance criteria against real VMs. Runs only locally.

**Files:** create `test/desktop-vm.test.ts`, `test/fixtures/desktop-task.html`.

- [ ] **Step 1: Add the task page.** Create `test/fixtures/desktop-task.html` with the spike's task page (`crumble-project/spikes/microsandbox/den/guest/task.html`): a form with Name, City select, Agree checkbox, Submit writing `name|city|yes` into `#out`, and a "More" disclosure whose "Show code" button writes a random `CODE-NNNN` into `#code`.

- [ ] **Step 2: Write the VM tests.** Create `test/desktop-vm.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createComputerUse } from "../src/computer-use";
import { MicrosandboxWorkspaces } from "../src/microsandbox-workspaces";

const IMAGE = process.env.CRUMBLE_WORKSPACE_IMAGE ?? "";
const DESKTOP_IMAGE = process.env.CRUMBLE_WORKSPACE_DESKTOP_IMAGE ?? "";
const vmTests = process.env.CRUMBLE_VM_TESTS === "1" && IMAGE !== "" && DESKTOP_IMAGE !== "";
const namePrefix = `crumble-desktop-test-${process.pid}`;
const page = readFileSync(path.join(import.meta.dir, "fixtures", "desktop-task.html"), "utf8");

describe.skipIf(!vmTests)("bot desktop in a VM", () => {
  const desktopBots = new Set(["desk"]);
  const workspaces = new MicrosandboxWorkspaces(IMAGE, {
    namePrefix,
    desktopImage: DESKTOP_IMAGE,
    wantsDesktop: (agentId) => desktopBots.has(agentId),
  });

  afterAll(() => workspaces.close(BACKGROUND_CONTEXT));

  const env = () => workspaces.env("desk");
  const cu = () => createComputerUse(env());
  const text = (r: { content: { type: string; text?: string }[] }) =>
    r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");
  const indexOf = (tree: string, pattern: RegExp) => Number(tree.split("\n").find((l) => pattern.test(l))!.match(/\[(\d+)\]/)![1]);

  test("opens a page, fills the form, and reads the result back", async () => {
    await env().writeFile("/workspace/task.html", page, BACKGROUND_CONTEXT);
    const tool = cu();

    await tool.run({ action: "key", keys: "ctrl+l" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "type", text: "file:///workspace/task.html" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "key", keys: "return" }, BACKGROUND_CONTEXT);
    await Bun.sleep(1500);

    const tree = text(await tool.run({ action: "capture", full: true }, BACKGROUND_CONTEXT));
    await tool.run({ action: "set_value", element: indexOf(tree, /entry "Name"/), value: "Ada Lovelace" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "click", element: indexOf(tree, /combo box "City"/) }, BACKGROUND_CONTEXT);
    await tool.run({ action: "type", text: "Berlin" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "key", keys: "return" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "click", element: indexOf(tree, /check box "Agree"/) }, BACKGROUND_CONTEXT);
    const after = await tool.run({ action: "click", element: indexOf(tree, /button "Submit"/), capture_after: true }, BACKGROUND_CONTEXT);

    expect(text(after)).toContain("Ada Lovelace|Berlin|yes");
  }, 120_000);

  test("operates a native GTK dialog", async () => {
    await env().exec(". /run/crumble-desktop.env; rm -f /tmp/z.out; (setsid zenity --entry --title Ask --text Name > /tmp/z.out &); sleep 2", undefined, BACKGROUND_CONTEXT);
    const tool = cu();
    const windows = text(await tool.run({ action: "list_windows" }, BACKGROUND_CONTEXT));
    const id = Number(windows.split("\n").find((l) => l.includes('"Ask"'))!.split(" ")[0]);
    const tree = text(await tool.run({ action: "capture", window_id: id, full: true }, BACKGROUND_CONTEXT));

    await tool.run({ action: "set_value", window_id: id, element: indexOf(tree, /text box/), value: "Ada" }, BACKGROUND_CONTEXT);
    await tool.run({ action: "click", window_id: id, element: indexOf(tree, /button "OK"/) }, BACKGROUND_CONTEXT);
    await Bun.sleep(500);

    let out = "";
    await env().exec("cat /tmp/z.out", { onOutput: (t) => (out += t) }, BACKGROUND_CONTEXT);
    expect(out.trim()).toBe("Ada");
  }, 60_000);

  test("browser state and files survive a restart", async () => {
    await env().writeFile("/workspace/keep.txt", "kept", BACKGROUND_CONTEXT);
    await workspaces.restart("desk", BACKGROUND_CONTEXT);

    let out = "";
    await env().exec("cat /workspace/keep.txt; ls /workspace/.desktop/chromium | head -1", { onOutput: (t) => (out += t) }, BACKGROUND_CONTEXT);
    expect(out).toContain("kept");
    expect(out).toContain("Default");
  }, 120_000);

  test("a bot without the desktop tool boots the base image", async () => {
    let out = "";
    await workspaces.env("plain").exec("command -v cua-driver || echo none", { onOutput: (t) => (out += t) }, BACKGROUND_CONTEXT);
    expect(out.trim()).toBe("none");
  }, 120_000);
});
```

- [ ] **Step 3: Run.**

```bash
CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev CRUMBLE_WORKSPACE_DESKTOP_IMAGE=crumble-workspace-desktop:dev bun test test/desktop-vm.test.ts
```

Expected: 4 pass. `bun test` without these variables skips them.

- [ ] **Step 4: Try a real model.** Start the server with both image variables, give a bot the `desktop` tool and `desktopModel` `opencode-go/gpt-6-luna` (OpenCode Go credentials saved in settings), and ask it: "Open flxw.dev and tell me what the page is about." Expected: a desktop job card, then the job's answer in the chat. Record steps, time, and cost in the pull request.

- [ ] **Step 5: Commit** (when the owner asks): `git add test/desktop-vm.test.ts test/fixtures/desktop-task.html && git commit -m "test(desktop): cover the bot desktop in a VM"`

## Acceptance criteria covered here

| Feature 0002 criterion | Task |
| --- | --- |
| Enable and disable the bot desktop; base image without it | 4, 7, 8 |
| Choose the desktop job model | 6 |
| Start, send, show; answer in the bot chat | 1, 6 |
| Open a URL, read, fill and submit a form, report a value | 8 |
| Operate a native GTK dialog | 8 |
| No shell, jobs, delegation, scheduling, integrations | 6, 7 |
| A second desktop job waits | 1 |
| Logins, files, and installed programs survive restarts | 2, 8 |
| Enabling keeps workspace files | 4, 8 |
| Interrupted job resumes or fails visibly | 1 (inherited from the coding reporter) |
| Idle bot desktop stops and restarts on demand | 4 (existing idle timer) |
| Asks instead of guessing; owner notified | 6 (instructions), 8 (real-model try-out); notification is the existing bot chat notification for job reports |

Watching, taking control, viewer links, and the paused job are milestone 2.
