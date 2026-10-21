# Desktop jobs, milestone 2: watching and taking control — Implementation Plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** The owner can watch a bot desktop live through a single-use viewer link, take control of it, and hand control back. While the owner has control, the bot's desktop job pauses and only the owner's input reaches the desktop. After control returns, nothing the job planned before runs. The server side and contract 1.5.0 only; apfelkern and the macOS client follow in milestone 3.
**Architecture:** A durable control lease per bot (`desktop-control.ts`, a `desktop_control` table) holds who has control and a change count. `computer_use` waits while the owner holds it and refuses stale plans after it returns. The viewer is a server-hosted noVNC page behind a single-use ticket; its WebSocket is bridged to the bot's Xvnc through an exec stream (no guest port), and an RFB filter (`rfb-filter.ts`, ported from the spike) drops the owner's input unless they hold control. An open viewer or an owner-held lease keeps the bot's machine awake. See [feature 0002](https://github.com/crumble-project/spec/blob/main/features/0002-desktop-jobs.md) and the spike's `den/viewer-server.mjs` and `den/takeover.mjs`.
**Tech stack:** Bun 1.4, Hono 4.13 (`hono/bun` WebSocket), `@earendil-works/pi-durable` 1.3.0, Microsandbox 0.7.8, `@novnc/novnc` 1.7.0 (MPL-2.0), Zod 4.

## Global constraints

- Work on branch `feat/0002-desktop-jobs-m2` in `bot`. Commit after each task; stage explicit paths only.
- Glossary terms: bot desktop, desktop job, taking control. API and code may say `desktop` and `control`.
- Watching never lets the owner's input through; only the holder `owner` does (feature 0002).
- A paused job waits without a time limit (feature 0002, Decisions).
- Only the owner can watch or take control; a viewer link cannot be reused (feature 0002, acceptance criteria).
- The bot desktop exposes no network port of its own: the viewer reaches Xvnc through an exec stream (feature 0002, Decisions).
- Contract changes raise the version to `1.5.0`, and `CHANGELOG.md` gets a `## Contract 1.5.0` section next to Unreleased, or the release job fails (it did for 1.4.0).
- A new event schema goes into `src/openapi.ts` `eventSchemas`; a minor release may add one.
- No `any`. Parse external input with Zod at the boundary. Type assertions need a `// SAFETY:` comment.
- Done means `bun run check` passes, plus the VM tests in Task 7 run locally.

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/store.ts` | Modify | `desktop_control` table; get and set the lease |
| `src/desktop-control.ts` | Create | The control lease: state, changes, listeners, waiting for the bot's turn |
| `src/computer-use.ts` | Modify | Wait while the owner holds control; refuse plans from before a change |
| `src/desktop.ts` | Modify | Pass the control lease to `computer_use` |
| `src/rfb-filter.ts` | Create | Client-to-server RFB filter, ported from the spike with the noVNC fixes |
| `src/workspace.ts` | Modify | `Workspaces.openDesktop`, `Workspaces.keepAwake` |
| `src/microsandbox-workspaces.ts` | Modify | Exec-stream bridge to Xvnc; awake holds |
| `src/desktop-viewer.ts` | Create | Single-use tickets, the viewer page, the WebSocket bridge |
| `src/api-responses.ts`, `src/api-contract.ts`, `src/api.ts` | Modify | Control and viewer routes, desktop events, contract 1.5.0 |
| `src/openapi.ts` | Modify | `desktop-control.schema.json` event schema |
| `src/server.ts` | Modify | Wire control, viewer routes, Bun WebSocket handler |
| `package.json`, `bun.lock` | Modify | `@novnc/novnc` 1.7.0 |
| `THIRD_PARTY_NOTICES.md` | Create or modify | noVNC under MPL-2.0 |
| `test/desktop-control.test.ts`, `test/rfb-filter.test.ts`, `test/desktop-viewer.test.ts` | Create | Unit tests |
| `test/computer-use.test.ts`, `test/api.test.ts`, `test/store.test.ts` | Modify | Pausing, routes, lease storage |
| `test/desktop-vm.test.ts` | Modify | VM acceptance: viewer, input filter, pause, hand-back, restart |
| `docs/architecture.md`, `CHANGELOG.md`, `README.md` | Modify | Documentation and contract changelog |

## Task 1: The control lease

**Files:** modify `src/store.ts` (migration after the `desktop_model` column; methods after `deleteAgent`); create `src/desktop-control.ts`, `test/desktop-control.test.ts`; modify `test/store.test.ts`.

**Interfaces produced:**
- `type ControlHolder = "bot" | "owner"`
- `type ControlState = { holder: ControlHolder; changes: number; updatedAt: string }`
- `Store.getDesktopControl(agentId: string): ControlState | null`, `Store.setDesktopControl(agentId: string, state: ControlState): void`
- `class DesktopControl` with `get(agentId): ControlState`, `set(agentId, holder): ControlState`, `subscribe(agentId, listener: (state: ControlState) => void): () => void`, `untilBot(agentId, context): Promise<ControlState>`

- [ ] **Step 1: Write the failing tests.** `test/desktop-control.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DesktopControl } from "../src/desktop-control";
import { agentInput } from "../src/domain";
import { Store } from "../src/store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "bot-control-"));

  dirs.push(dir);

  const store = new Store(dir);
  const agent = store.createAgent(agentInput.parse({ name: "Desk" }));

  return { dir, store, agentId: agent.id };
}

test("the bot holds control until the owner takes it, and every change counts", () => {
  const { store, agentId } = open();
  const control = new DesktopControl(store);

  expect(control.get(agentId)).toMatchObject({ holder: "bot", changes: 0 });
  expect(control.set(agentId, "owner")).toMatchObject({
    holder: "owner",
    changes: 1,
  });

  // Setting the current holder again changes nothing.
  expect(control.set(agentId, "owner")).toMatchObject({
    holder: "owner",
    changes: 1,
  });
  expect(control.set(agentId, "bot")).toMatchObject({
    holder: "bot",
    changes: 2,
  });
  store.close();
});

test("the lease survives a restart", () => {
  const { dir, store, agentId } = open();

  new DesktopControl(store).set(agentId, "owner");
  store.close();

  const reopened = new Store(dir);

  expect(new DesktopControl(reopened).get(agentId)).toMatchObject({
    holder: "owner",
    changes: 1,
  });
  reopened.close();
});

test("waiting for the bot's turn resolves on hand-back, and listeners hear each change", async () => {
  const { store, agentId } = open();
  const control = new DesktopControl(store);
  const heard: string[] = [];
  const stop = control.subscribe(agentId, (state) => heard.push(state.holder));

  control.set(agentId, "owner");

  let resolved = false;

  const waiting = control
    .untilBot(agentId, BACKGROUND_CONTEXT)
    .then(() => (resolved = true));

  await Bun.sleep(50);
  expect(resolved).toBe(false);

  control.set(agentId, "bot");
  await waiting;
  expect(heard).toEqual(["owner", "bot"]);
  stop();
  store.close();
});

test("deleting a bot deletes its lease", () => {
  const { store, agentId } = open();

  new DesktopControl(store).set(agentId, "owner");
  store.deleteAgent(agentId);
  expect(store.getDesktopControl(agentId)).toBeNull();
  store.close();
});
```

- [ ] **Step 2: Run.** `bun test test/desktop-control.test.ts` — expected: FAIL, cannot resolve `../src/desktop-control`.

- [ ] **Step 3: Store the lease.** In `src/store.ts` `migrate()`:

```ts
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS desktop_control (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, holder TEXT NOT NULL, changes INTEGER NOT NULL, updated_at TEXT NOT NULL)",
    );
```

and after `deleteAgent`:

```ts
  getDesktopControl(agentId: Id): ControlState | null {
    const row = this.db
      .query<{ holder: string; changes: number; updated_at: string }, [string]>(
        "SELECT holder, changes, updated_at FROM desktop_control WHERE agent_id=?",
      )
      .get(agentId);

    return row
      ? { holder: row.holder === "owner" ? "owner" : "bot", changes: row.changes, updatedAt: row.updated_at }
      : null;
  }
  setDesktopControl(agentId: Id, state: ControlState) {
    this.db
      .query(
        "INSERT INTO desktop_control (agent_id, holder, changes, updated_at) VALUES (?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET holder=excluded.holder, changes=excluded.changes, updated_at=excluded.updated_at",
      )
      .run(agentId, state.holder, state.changes, state.updatedAt);
  }
```

Import `ControlState` from `./desktop-control` as a type. The foreign key matches how other per-agent tables reference `agents(id)`; check the existing tables and match their style (drop the `REFERENCES` clause if they do not use one, and delete the row in `deleteAgent` instead).

- [ ] **Step 4: Write `src/desktop-control.ts`.**

```ts
import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Store } from "./store";

export type ControlHolder = "bot" | "owner";

/** Who operates a bot desktop. `changes` counts every change of holder, so a plan from before one can be recognized. */
export type ControlState = {
  holder: ControlHolder;
  changes: number;
  updatedAt: string;
};

type Listener = (state: ControlState) => void;

/** The control lease of each bot desktop: durable in the store, with listeners for live updates. */
export class DesktopControl {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly store: Store) {}

  get(agentId: string): ControlState {
    return (
      this.store.getDesktopControl(agentId) ?? {
        holder: "bot",
        changes: 0,
        updatedAt: new Date(0).toISOString(),
      }
    );
  }

  set(agentId: string, holder: ControlHolder): ControlState {
    const current = this.get(agentId);

    if (current.holder === holder) return current;

    const next: ControlState = {
      holder,
      changes: current.changes + 1,
      updatedAt: new Date().toISOString(),
    };

    this.store.setDesktopControl(agentId, next);

    for (const listener of this.listeners.get(agentId) ?? []) listener(next);

    return next;
  }

  subscribe(agentId: string, listener: Listener) {
    const set = this.listeners.get(agentId) ?? new Set<Listener>();

    set.add(listener);
    this.listeners.set(agentId, set);

    return () => void set.delete(listener);
  }

  /** Resolves once the bot holds control: at once, or when the owner hands it back. */
  untilBot(agentId: string, context: Context): Promise<ControlState> {
    const current = this.get(agentId);

    if (current.holder === "bot") return Promise.resolve(current);

    let stop = () => {};

    const handedBack = new Promise<ControlState>((resolve) => {
      stop = this.subscribe(agentId, (state) => {
        if (state.holder === "bot") resolve(state);
      });
    });

    return awaitWithContext(handedBack, context).finally(stop);
  }
}
```

- [ ] **Step 5: Store coverage.** As built, `test/desktop-control.test.ts` covers the store: the lease round-trips across reopen, and deleting a bot deletes its lease (the table cascades like the other per-agent tables).

- [ ] **Step 6: Run.** `bun test test/desktop-control.test.ts test/store.test.ts && bun run typecheck` — expected: pass.

- [ ] **Step 7: Commit.** `git add src/store.ts src/desktop-control.ts test/desktop-control.test.ts test/store.test.ts && git commit -m "feat(desktop): add the desktop control lease"`

## Task 2: The desktop job pauses while the owner has control

**Files:** modify `src/computer-use.ts` (`createComputerUse`, `computerUseTool`), `src/desktop.ts` (`desktopExtensions`), `src/server.ts` (the `desktop` extensions factory), `test/computer-use.test.ts`, `test/desktop.test.ts`.

**Interfaces consumed:** `DesktopControl` (Task 1).

**Interfaces produced:**
- `type ControlGate = { untilBot(context: Context): Promise<ControlState> }`
- `createComputerUse(shell: DesktopShell, gate?: ControlGate)`
- `computerUseTool(gate?: (conversationId: string) => ControlGate)` — unchanged without a gate.
- `desktopExtensions(agent, control?: DesktopControl)`

Behavior, in `run()` before anything else:

1. `const state = await gate.untilBot(context)`; this blocks while the owner holds control.
2. If this instance has seen a state before and `state.changes !== lastChanges`: clear snapshots, record the new count, and refuse every action except `capture`, `list_windows`, and `wait` with: "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting."
3. Record `lastChanges = state.changes` on every call.

- [ ] **Step 1: Write the failing tests.** Append to `test/computer-use.test.ts`:

```ts
class FakeGate {
  state = { holder: "bot" as "bot" | "owner", changes: 0, updatedAt: "" };
  private waiting: (() => void)[] = [];

  untilBot = async () => {
    while (this.state.holder !== "bot") await new Promise<void>((r) => this.waiting.push(r));
    return this.state;
  };

  set(holder: "bot" | "owner") {
    this.state = { ...this.state, holder, changes: this.state.changes + 1 };
    for (const resume of this.waiting.splice(0)) resume();
  }
}

test("actions wait while the owner holds control", async () => {
  const gate = new FakeGate();
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [{ snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' }],
    set_value: [{ effect: "confirmed" }],
  });
  const tool = createComputerUse(shell, gate);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);
  gate.set("owner");

  let done = false;
  const pending = tool.run({ action: "set_value", element: 2, value: "Ada" }, BACKGROUND_CONTEXT).then((r) => {
    done = true;
    return r;
  });

  await Bun.sleep(50);
  expect(done).toBe(false);
  expect(calls.some((c) => c.tool === "set_value")).toBe(false);

  gate.set("bot");
  const result = await pending;

  // The plan was made before the owner took control: refused, and the old snapshot is gone.
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("Capture before acting");
  expect(calls.some((c) => c.tool === "set_value")).toBe(false);

  const fresh = await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);
  expect(fresh.isError).toBe(false);
  expect(calls.filter((c) => c.tool === "get_window_state").at(-1)?.args.since).toBeUndefined();
});

test("without a change of control, actions run as before", async () => {
  const gate = new FakeGate();
  const { shell, calls } = scriptedGuest({
    list_windows: [windows],
    get_window_state: [{ snapshot_id: "s1", tree_markdown: '- [2] entry "Name"' }],
    set_value: [{ effect: "confirmed" }],
  });
  const tool = createComputerUse(shell, gate);

  await tool.run({ action: "capture" }, BACKGROUND_CONTEXT);
  const result = await tool.run({ action: "set_value", element: 2, value: "Ada" }, BACKGROUND_CONTEXT);

  expect(result.isError).toBe(false);
  expect(calls.some((c) => c.tool === "set_value")).toBe(true);
});
```

- [ ] **Step 2: Run.** `bun test test/computer-use.test.ts` — expected: FAIL; `createComputerUse` ignores the gate.

- [ ] **Step 3: Implement.** In `src/computer-use.ts`:

```ts
import type { ControlState } from "./desktop-control";

/** The bot's turn on its desktop: resolves once the bot holds control. */
export type ControlGate = { untilBot(context: Context): Promise<ControlState> };

const OBSERVE = new Set(["capture", "list_windows", "wait"]);

const STALE =
  "Control changed hands: the owner used the bot desktop and handed it back. The screen may have changed and element numbers are stale. Capture before acting.";
```

In `createComputerUse(shell: DesktopShell, gate?: ControlGate)`, add `let lastChanges: number | undefined;` and at the start of `run`, before `normalize`:

```ts
    if (gate) {
      // A paused job waits here, without a time limit, while the owner has control.
      const state = await gate.untilBot(context);
      const changed = lastChanges !== undefined && state.changes !== lastChanges;

      lastChanges = state.changes;

      if (changed) {
        snapshots.clear();

        if (!OBSERVE.has(raw.action)) return text(STALE, true);
      }
    }
```

(`text` is the result helper already in `run`; move its definition above this block.)

`computerUseTool(gateFor?: (conversationId: string) => ControlGate)` passes `gateFor?.(key)` to `createComputerUse`. In `src/desktop.ts`:

```ts
export function desktopExtensions(
  agent: Pick<Agent, "id" | "desktopModel">,
  control?: DesktopControl,
): JobExtensions {
  const job = defineExtension({
    name: "desktop-job",
    tools: [
      computerUseTool(
        control && (() => ({ untilBot: (context) => control.untilBot(agent.id, context) })),
      ),
    ],
  });
  // ...unchanged
}
```

In `src/server.ts`, construct `const desktopControl = new DesktopControl(store);` next to `workspaces` and call `desktopExtensions(agent, desktopControl)`.

- [ ] **Step 4: Run.** `bun test test/computer-use.test.ts test/desktop.test.ts && bun run typecheck` — expected: pass.

- [ ] **Step 5: Commit.** `git add src/computer-use.ts src/desktop.ts src/server.ts test/computer-use.test.ts && git commit -m "feat(desktop): pause desktop jobs while the owner has control"`

## Task 3: The RFB input filter

Port of the spike's `den/viewer-server.mjs` filter, with the noVNC fixes (negative clipboard length, QEMU extended key events, xvp).

**Files:** create `src/rfb-filter.ts`, `test/rfb-filter.test.ts`.

**Interfaces produced:** `rfbFilter(allowInput: () => boolean): { push(chunk: Uint8Array): Uint8Array; stats: { passed: number; dropped: number } }`; `push` throws `RfbProtocolError` on an unknown client message type.

- [ ] **Step 1: Write the failing tests.**

```ts
import { expect, test } from "bun:test";
import { rfbFilter, RfbProtocolError } from "../src/rfb-filter";

const handshake = new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]);
const pointer = new Uint8Array([5, 0, 0, 10, 0, 20]);
const key = new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61]);
const update = new Uint8Array([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const qemuKey = new Uint8Array([255, 0, 0, 1, 0, 0, 0, 0x78, 0, 0, 0, 0x2d]);

const clipboardCaps = () => {
  const m = new Uint8Array(16);
  const view = new DataView(m.buffer);
  m[0] = 6;
  view.setInt32(4, -8);
  return m;
};

const concat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((p) => [...p]));

test("the handshake passes, input is dropped unless allowed, and updates always pass", () => {
  let allowed = false;
  const filter = rfbFilter(() => allowed);

  expect(filter.push(handshake)).toEqual(handshake);
  expect(filter.push(concat(pointer, key, update))).toEqual(update);

  allowed = true;
  expect(filter.push(concat(pointer, key))).toEqual(concat(pointer, key));
});

test("noVNC's extended clipboard message has a negative length and does not stall the stream", () => {
  const filter = rfbFilter(() => false);
  filter.push(handshake);

  expect(filter.push(concat(clipboardCaps(), update))).toEqual(update);
});

test("QEMU extended key events are input", () => {
  let allowed = false;
  const filter = rfbFilter(() => allowed);
  filter.push(handshake);

  expect(filter.push(qemuKey)).toEqual(new Uint8Array());
  allowed = true;
  expect(filter.push(qemuKey)).toEqual(qemuKey);
});

test("messages split across chunks are reassembled", () => {
  const filter = rfbFilter(() => true);
  filter.push(handshake);

  expect(filter.push(update.subarray(0, 4))).toEqual(new Uint8Array());
  expect(filter.push(update.subarray(4))).toEqual(update);
});

test("an unknown message type is a protocol error", () => {
  const filter = rfbFilter(() => true);
  filter.push(handshake);

  expect(() => filter.push(new Uint8Array([99, 0, 0]))).toThrow(RfbProtocolError);
});
```

- [ ] **Step 2: Run.** `bun test test/rfb-filter.test.ts` — expected: FAIL, module missing.

- [ ] **Step 3: Implement `src/rfb-filter.ts`.**

```ts
/** A client message type the filter does not know: the connection must close, since its length is unknown. */
export class RfbProtocolError extends Error {}

// Handshake for RFB 3.8 with security None: version (12 bytes), security type (1), ClientInit (1).
const HANDSHAKE_BYTES = 14;

// KeyEvent, PointerEvent, ClientCutText, xvp (power operations), SetDesktopSize, QEMU extended key event.
const INPUT = new Set([4, 5, 6, 250, 251, 255]);

/** Length of the client message at the start of `b`; 0 when more bytes are needed. */
function messageLength(b: Uint8Array): number {
  if (b.length < 1) return 0;

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);

  switch (b[0]) {
    case 0:
      return 20; // SetPixelFormat
    case 2:
      return b.length < 4 ? 0 : 4 + 4 * view.getUint16(2); // SetEncodings
    case 3:
      return 10; // FramebufferUpdateRequest
    case 4:
      return 8; // KeyEvent
    case 5:
      return 6; // PointerEvent
    case 6:
      // ClientCutText; the extended clipboard (noVNC, TigerVNC) sends a negative length.
      return b.length < 8 ? 0 : 8 + Math.abs(view.getInt32(4));
    case 150:
      return 10; // EnableContinuousUpdates
    case 248:
      return b.length < 9 ? 0 : 9 + (b[8] ?? 0); // ClientFence
    case 250:
      return 4; // xvp
    case 251:
      return b.length < 7 ? 0 : 8 + 16 * (b[6] ?? 0); // SetDesktopSize
    case 255:
      if (b.length < 2) return 0;

      // QEMU client message; only the extended key event is known.
      if (b[1] === 0) return 12;

      throw new RfbProtocolError(`unknown QEMU client message ${b[1]}`);
    default:
      throw new RfbProtocolError(`unknown RFB client message ${b[0]}`);
  }
}

/** Filters the viewer's client-to-server RFB stream: input passes only while `allowInput()` is true. */
export function rfbFilter(allowInput: () => boolean) {
  let handshake = HANDSHAKE_BYTES;
  let buffer = new Uint8Array();
  const stats = { passed: 0, dropped: 0 };

  return {
    stats,
    push(chunk: Uint8Array): Uint8Array {
      buffer = buffer.length ? new Uint8Array([...buffer, ...chunk]) : chunk;
      const out: Uint8Array[] = [];

      if (handshake > 0) {
        const n = Math.min(handshake, buffer.length);

        out.push(buffer.subarray(0, n));
        buffer = buffer.subarray(n);
        handshake -= n;
      }

      while (handshake === 0 && buffer.length) {
        const length = messageLength(buffer);

        if (length === 0 || buffer.length < length) break;

        const message = buffer.subarray(0, length);

        buffer = buffer.subarray(length);

        if (INPUT.has(message[0] ?? -1) && !allowInput()) {
          stats.dropped += 1;
          continue;
        }

        stats.passed += 1;
        out.push(message);
      }

      return new Uint8Array(out.flatMap((part) => [...part]));
    },
  };
}
```

Replace the array spreads with a single preallocated copy if `bun test` shows the throughput test from Task 7 to be slow; correctness first.

- [ ] **Step 4: Run.** `bun test test/rfb-filter.test.ts` — expected: pass.

- [ ] **Step 5: Commit.** `git add src/rfb-filter.ts test/rfb-filter.test.ts && git commit -m "feat(desktop): filter viewer input by control"`

## Task 4: A desktop stream from the workspace

**Files:** modify `src/workspace.ts` (`Workspaces`), `src/microsandbox-workspaces.ts` (`Workspace`, `MicrosandboxWorkspaces`), test fakes in `test/coding.test.ts`, `test/jobs.test.ts`, `test/desktop.test.ts`; modify `test/microsandbox-workspaces.test.ts`.

**Interfaces produced:**
- `type DesktopStream = { write(data: Uint8Array): Promise<void>; output: AsyncIterable<Uint8Array>; close(): Promise<void> }`
- `Workspaces.openDesktop(agentId: string, context: Context): Promise<DesktopStream>` — boots the machine if needed and connects to Xvnc on `127.0.0.1:5900` in the guest through `socat`, an exec stream like the pi-env relay. It keeps the machine awake until closed. Throws for a bot without its bot desktop.
- `Workspaces.keepAwake(agentId: string): () => void` — keeps the machine from its idle stop until the returned release is called.

- [ ] **Step 1: Write the failing VM test.** In `test/desktop-vm.test.ts`, add:

```ts
  test("a desktop stream speaks RFB and keeps the machine awake", async () => {
    const idle = new MicrosandboxWorkspaces(IMAGE, {
      namePrefix,
      idleTimeoutMs: 500,
      desktopImage: DESKTOP_IMAGE,
      wantsDesktop: () => true,
    });

    try {
      const stream = await idle.openDesktop("stream", BACKGROUND_CONTEXT);
      const first = await stream.output[Symbol.asyncIterator]().next();

      expect(new TextDecoder().decode(first.value)).toStartWith("RFB 003.");
      await Bun.sleep(3000);
      expect((await Sandbox.get(idle.name("stream"))).status).toBe("running");
      await stream.close();
      await Bun.sleep(3000);
      expect((await Sandbox.get(idle.name("stream"))).status).toBe("stopped");
    } finally {
      await idle.close(BACKGROUND_CONTEXT);
    }
  }, 120_000);
```

Import `Sandbox` from `microsandbox` in that file.

- [ ] **Step 2: Run.** `CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev CRUMBLE_WORKSPACE_DESKTOP_IMAGE=crumble-workspace-desktop:dev bun test test/desktop-vm.test.ts -t "desktop stream"` — expected: FAIL, `openDesktop` is not a function.

- [ ] **Step 3: Implement.** In `src/workspace.ts`, add `DesktopStream` and the two members. In `src/microsandbox-workspaces.ts`:

`Workspace` gains a hold counter that the idle timer respects:

```ts
  private holds = 0;

  /** Keeps the machine from its idle stop until released; an open viewer or an owner holding control. */
  hold() {
    this.holds += 1;
    clearTimeout(this.idleTimer);
    let released = false;

    return () => {
      if (released) return;

      released = true;
      this.holds -= 1;
      this.armIdleTimer();
    };
  }
```

and `armIdleTimer` returns early when `this.holds > 0`, alongside `this.inflight > 0`; `stop(false)` also returns early when `holds > 0`.

`Workspace.openDesktop()`:

```ts
  async openDesktop(): Promise<DesktopStream> {
    await this.ensureStarted();
    const running = this.running;

    if (!running || running.image !== this.owner.desktopImageName())
      throw new Error("This bot has no bot desktop");

    const release = this.hold();
    const exec = await running.sandbox.execStreamWith("socat", (options) =>
      options.args(["-", "TCP:127.0.0.1:5900"]).stdinPipe(),
    );
    const stdin = await exec.takeStdin();

    if (!stdin) {
      release();
      throw new Error("The desktop stream has no stdin");
    }

    async function* output() {
      for await (const event of exec)
        if (event.kind === "stdout") yield new Uint8Array(event.data);
    }

    return {
      write: (data) => stdin.write(data),
      output: output(),
      close: async () => {
        release();
        await stdin.close().catch(() => undefined);
      },
    };
  }
```

`MicrosandboxWorkspaces` adds `desktopImageName()` (returns `this.desktopImage`), `openDesktop(agentId)` (delegates to the bot's `Workspace`), and `keepAwake(agentId)` (delegates to `hold()`). The test fakes return a no-op `keepAwake` and an `openDesktop` that throws.

- [ ] **Step 4: Run.** The command from Step 2, then `bun run check` — expected: pass.

- [ ] **Step 5: Commit.** `git add src/workspace.ts src/microsandbox-workspaces.ts test/*.test.ts && git commit -m "feat(workspace): stream the bot desktop and keep it awake while watched"`

## Task 5: Viewer tickets, page, and WebSocket bridge

**Files:** create `src/desktop-viewer.ts`, `test/desktop-viewer.test.ts`; modify `package.json` (`@novnc/novnc` 1.7.0), `THIRD_PARTY_NOTICES.md`.

**Interfaces consumed:** `DesktopControl` (Task 1), `rfbFilter` (Task 3), `Workspaces.openDesktop` (Task 4).

**Interfaces produced:**
- `class ViewerTickets` with `issue(agentId: string): { ticket: string; expiresAt: string }` and `redeem(ticket: string): string | undefined` (the agent ID, once, before expiry). Tickets are 32 random bytes, base64url, valid 60 s, and in memory only.
- `viewerPage(ticket: string): string` — HTML loading noVNC from `/desktop-viewer/novnc/core/rfb.js` and connecting to `/desktop-viewer/{ticket}/websockify`; the RFB view scales to the window, has no own controls, and is `viewOnly` false (the server filter decides).
- `bridgeDesktop(options: { stream: DesktopStream; allowInput: () => boolean; send: (data: Uint8Array) => void; close: () => void })` returning `{ receive(data: Uint8Array): void; close(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests.** `test/desktop-viewer.test.ts`:

```ts
import { expect, test } from "bun:test";
import { bridgeDesktop, ViewerTickets, viewerPage } from "../src/desktop-viewer";

test("a ticket is redeemed once, and not after it expires", () => {
  let now = 0;
  const tickets = new ViewerTickets(() => now);
  const { ticket } = tickets.issue("bot-a");

  expect(tickets.redeem(ticket)).toBe("bot-a");
  expect(tickets.redeem(ticket)).toBeUndefined();

  const late = tickets.issue("bot-a").ticket;
  now = 61_000;
  expect(tickets.redeem(late)).toBeUndefined();
});

test("the viewer page connects to its ticket's stream and loads noVNC from the server", () => {
  const page = viewerPage("abc");

  expect(page).toContain("/desktop-viewer/novnc/core/rfb.js");
  expect(page).toContain("/desktop-viewer/abc/websockify");
});

test("the bridge filters the viewer's input and forwards the desktop's output", async () => {
  const toViewer: Uint8Array[] = [];
  const toDesktop: Uint8Array[] = [];
  let allowed = false;

  async function* output() {
    yield new TextEncoder().encode("RFB 003.008\n");
  }

  const bridge = bridgeDesktop({
    stream: { write: async (d) => void toDesktop.push(d), output: output(), close: async () => {} },
    allowInput: () => allowed,
    send: (d) => toViewer.push(d),
    close: () => {},
  });

  bridge.receive(new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]));
  bridge.receive(new Uint8Array([5, 0, 0, 1, 0, 1]));
  allowed = true;
  bridge.receive(new Uint8Array([5, 0, 0, 2, 0, 2]));
  await Bun.sleep(10);

  expect(new TextDecoder().decode(toViewer[0])).toBe("RFB 003.008\n");
  expect(toDesktop.map((d) => d[0])).toEqual([82, 5]); // handshake ("R..."), then only the allowed pointer event
  await bridge.close();
});
```

- [ ] **Step 2: Run.** `bun test test/desktop-viewer.test.ts` — expected: FAIL, module missing.

- [ ] **Step 3: Implement `src/desktop-viewer.ts`.** Tickets: a `Map<string, { agentId: string; expires: number }>` and an injectable clock. Page: a static HTML string; the spike's `den/viewer.html` without its buttons, with `rfb.scaleViewport = true` and `rfb.background = "#000"`. Bridge: a `rfbFilter(allowInput)` on `receive`, writes chained in order (as the relay does), a loop forwarding `stream.output` to `send`, and `close` on any `RfbProtocolError` or when the output ends.

- [ ] **Step 4: Add noVNC.** `bun add @novnc/novnc@1.7.0`. In `THIRD_PARTY_NOTICES.md` (create it if missing, following the desktop repository's format: a heading, a paragraph naming the project, license, and copyright, then the license text), add a `## noVNC` section: served unmodified to the viewer from `node_modules/@novnc/novnc`, MPL-2.0, Copyright (C) the noVNC authors, source at https://github.com/novnc/noVNC.

- [ ] **Step 5: Run.** `bun test test/desktop-viewer.test.ts && bun run check` — expected: pass.

- [ ] **Step 6: Commit.** `git add src/desktop-viewer.ts test/desktop-viewer.test.ts package.json bun.lock THIRD_PARTY_NOTICES.md && git commit -m "feat(desktop): add single-use viewer tickets and the viewer bridge"`

## Task 6: Control and viewer API, contract 1.5.0

**Files:** modify `src/api-responses.ts`, `src/api-contract.ts`, `src/api.ts`, `src/openapi.ts`, `src/server.ts`, `openapi/openapi.json`, `test/api.test.ts`, `CHANGELOG.md`, `docs/architecture.md`, `README.md`.

**Interfaces produced (HTTP):**
- `GET /v1/agents/{id}/desktop/control` → `DesktopControl { holder: "bot" | "owner", changes: number, updatedAt: string }`
- `PUT /v1/agents/{id}/desktop/control` with `{ holder: "bot" | "owner" }` → `DesktopControl`. 409 when the bot has no `desktop` tool or the server has no desktop image.
- `GET /v1/agents/{id}/desktop/events` → SSE: a `control` event with `DesktopControl` at once and on every change, and `heartbeat` every 15 s, like the chat stream.
- `POST /v1/agents/{id}/desktop/viewer` → `DesktopViewer { path: string, expiresAt: string }`; `path` is `/desktop-viewer/{ticket}`, relative to the server.
- Outside `/v1` and its bearer auth: `GET /desktop-viewer/{ticket}` (the page, `Cache-Control: no-store`), `GET /desktop-viewer/novnc/*` (noVNC files), and the WebSocket upgrade at `/desktop-viewer/{ticket}/websockify`, which redeems the ticket. A redeemed, expired, or unknown ticket gets 404 on the page and a refused upgrade.
- Event schema `desktop-control.schema.json` in `eventSchemas`.
- While the owner holds control, the server holds `workspaces.keepAwake(agentId)`; it is taken at startup for every lease held by the owner, and released on hand-back.

- [ ] **Step 1: Write the failing API tests** in `test/api.test.ts`, with a fake `Workspaces` whose `keepAwake` records calls:
  - `PUT …/desktop/control` with `owner`, then `GET` returns `{ holder: "owner", changes: 1 }` and the fake recorded one hold; `bot` releases it.
  - `PUT` for a bot without the `desktop` tool returns 409.
  - `POST …/desktop/viewer` returns a `path` starting with `/desktop-viewer/`; `GET` of that path returns HTML; a second WebSocket upgrade with the same ticket is refused (call the handler's ticket check directly if the test app cannot upgrade).
  - `GET /desktop-viewer/novnc/core/rfb.js` returns JavaScript; `GET /desktop-viewer/novnc/../package.json` does not escape the noVNC directory.
  - Without the bearer token, `/v1/agents/{id}/desktop/viewer` is 401.

- [ ] **Step 2: Run.** `bun test test/api.test.ts` — expected: FAIL on the new tests.

- [ ] **Step 3: Implement** the schemas (`desktopControlResponse`, `desktopControlInput`, `desktopViewerResponse`), routes, handlers, the SSE stream (copy the `chatEvents` handler's structure: `subscribe`, heartbeat, finish on abort), and the server wiring:
  - `createAPI` options gain `desktopControl?: DesktopControl`, `viewerTickets?: ViewerTickets`, `openDesktop?: (agentId: string) => Promise<DesktopStream>`.
  - In `src/server.ts`, use `upgradeWebSocket` and `websocket` from `hono/bun`: register the `/desktop-viewer/:ticket/websockify` route before the `/v1/*` bearer middleware, redeem the ticket in the upgrade handler, then `bridgeDesktop` with `allowInput: () => desktopControl.get(agentId).holder === "owner"`. Pass `websocket` to `Bun.serve`.
  - Serve noVNC with a path check like the spike's (normalize, strip leading `../`, require the resolved path to stay under the package directory).
  - Contract `version: "1.5.0"`, `bun run openapi:generate`, and add `desktop-control.schema.json` to `eventSchemas`.

- [ ] **Step 4: Docs.** `CHANGELOG.md`: an Unreleased entry describing watching, taking control, the paused job, and keeping the machine awake; and a new `## Contract 1.5.0` section listing the four routes, the `DesktopControl` and `DesktopViewer` schemas, and the `desktop-control.schema.json` event. `docs/architecture.md`: a "Watching and taking control" subsection under "Desktop jobs". `README.md`: none needed beyond the API (the desktop image is unchanged).

- [ ] **Step 5: Run.** `bun run check && bun src/contract-release.ts validate` — expected: pass. Commit and run `D=$(mktemp -d) && bun src/openapi.ts --bundle "$D"`: it must export, including the 1.5.0 changelog section.

- [ ] **Step 6: Commit.** `git add src/api-responses.ts src/api-contract.ts src/api.ts src/openapi.ts src/server.ts openapi/openapi.json test/api.test.ts CHANGELOG.md docs/architecture.md && git commit -m "feat(desktop): serve the viewer and control over the API"`

## Task 7: Local VM acceptance tests

**Files:** modify `test/desktop-vm.test.ts`; reuse the spike's RFB client from `den/takeover.mjs` as a test helper in `test/fixtures/rfb-client.ts` (handshake, `pointer`, `qemuKey`, `clipboardCaps`, `smallUpdate`).

Start a real server (`startServer` from `src/server.ts`, as `test/e2e.test.ts` does) with both images and a bot with the `desktop` tool, then:

- [ ] **Watching:** issue a viewer link, load the page (200), connect a WebSocket to its `websockify` path with the RFB client: the handshake completes and a framebuffer update arrives after noVNC's clipboard message.
- [ ] **Watching blocks input:** with the bot holding control, a pointer event to (300, 300) leaves `xdotool getmouselocation` unchanged.
- [ ] **Taking control:** `PUT control owner`; the pointer event moves the pointer, and a QEMU key event types into a focused field (check with `xdotool getwindowname` or the accessibility tree through `computer_use` capture).
- [ ] **Paused job:** start a desktop job with the faux model scripted to capture, then `set_value`. Take control between the two calls; the `set_value` waits, and after hand-back it returns "Capture before acting" and the field is unchanged.
- [ ] **Single-use link:** a second WebSocket to the same `websockify` path is refused.
- [ ] **Owner keeps control across a restart:** take control, stop and start the server on the same data directory, and `GET control` still says `owner`; a desktop job call still waits.
- [ ] **Awake while watched:** with `idleTimeoutMs` 500 and the viewer connected, the machine is `running` after 3 s; after closing it and handing back, it stops.

Run: `CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev CRUMBLE_WORKSPACE_DESKTOP_IMAGE=crumble-workspace-desktop:dev bun test test/desktop-vm.test.ts` — expected: all pass. Commit: `git add test/desktop-vm.test.ts test/fixtures/rfb-client.ts && git commit -m "test(desktop): cover watching and taking control in a VM"`.

Then try it by hand: start the server with both images, issue a viewer link with `curl`, open `http://127.0.0.1:7337/desktop-viewer/<ticket>` in a browser, take and hand back control with `curl`, and record what happened in the pull request.

## Acceptance criteria covered here

| Feature 0002 criterion | Task |
| --- | --- |
| The owner can watch a bot desktop live | 4, 5, 6, 7 (the macOS view is milestone 3) |
| Watching alone never lets input through | 3, 5, 7 |
| Taking control lets pointer, keyboard, and clipboard through; the job takes no action | 1, 2, 3, 7 |
| A plan from before taking control does not run; the job captures first | 2, 7 |
| Only the owner can watch or take control; a viewer link cannot be reused | 5, 6, 7 |
| Owner keeps control across a server restart or client disconnect | 1, 6, 7 |
| A watched or controlled bot desktop does not count as idle | 4, 6, 7 |
| Notification opens the view | Milestone 3 (client) |
