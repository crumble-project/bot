# Browser actions implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [x]`.

**Goal:** Desktop jobs get web work done in fewer, faster `computer_use` calls: page actions over cua-driver's browser binding, narrowed captures, and batched steps for any app.

**Architecture:** `computer_use` keeps one tool and one cua-driver session per job. Page actions bind the job's session to the target Chromium window on every call (about 15 ms), attach it once per session with `browser_prepare`, and act on page refs (`p<snapshot>:<index>`). Accessibility actions stay for browser chrome, dialogs, and other apps. The logins plan (`docs/plans/2026-10-29-logins.md`) builds `fill_login` on this binding.

**Source:** Spike and measurements in `docs/bot-desktop-research.md` ("Spike: page tools against the accessibility path"); the session's design discussion (below, under Decisions).

## Status

Implemented on 2026-10-30, uncommitted. Changes from the plan, found while building it in the VM:

- Binding the tab again supersedes the refs of the last read (`browser_ref_stale`). So only `open` and `read` bind; ref actions reuse the binding of the latest read (`state.lastRead = { page, read }`, one entry, not a map per tab) and act on the tab the ref came from. A ref action before any read is refused: "read the page first, then act on a ref from it".
- A second cua-driver session can't attach while another session holds Chromium (`browser_requires_setup`); a session that ended and started again under the same label can attach again. So every job on a bot desktop uses one session label, `crumble-desktop` (`computer-use-state.ts`), and an ended session is started again with `start_session` instead of replaced. No `browserAttached` flag: a refused bind attaches.
- `open` counts the page as loaded when the title changes, or when the tab's URL moved (or is the requested URL, for a reload) and held for 1 s.
- `read` doesn't hide password values itself: the semantic snapshot doesn't mark password fields, and cua-driver reports their value as null (spike). Logins scrub filled values.
- `capture` with `query` keeps its snapshot for element tokens; the next plain capture reads the whole tree instead of diffing against a filtered one (`state.queried`).
- cua-driver replies keep unknown fields (`z.looseObject`) so page and steps code can parse their own fields.

## Decisions

- Keep cua-driver and Debian Chromium. Lightpanda (no rendering, no headed mode) and Camoufox (Firefox; cua-driver's page tools are CDP-only) don't fit a desktop the owner watches and takes over (`docs/bot-desktop-research.md`).
- Page actions reuse the tool's action names where the meaning is the same: `click`, `type`, `set_value`, `scroll` take a `ref` (page) instead of `element` (accessibility). Only two actions are new: `open` (a URL) and `read` (the page). One tool keeps the job's prompt and the control gate unchanged.
- Bind on every page action instead of caching tab IDs: binding costs 9-16 ms in the spike and always yields the active tab and its current URL, so a tab the owner switched to during control is never acted on by a stale ID. Refs from a previous read stay valid only while cua-driver says so; a stale ref returns cua-driver's refusal as the result.
- Attach lazily: `browser_prepare` attaches only the session that ran it (spike: another session's bind was refused), so attaching at desktop start can't help. The first page action of a job pays about 7.7 s and its reply says "Chromium was attached for page actions; accessibility element numbers are stale." Accessibility snapshots are cleared then, because preparing opens a setup page and moves focus.
- `open` waits for the page: it polls `get_browser_state` (`snapshot_format: "semantic_v2"`, `query` the URL's host) every 250 ms for up to 10 s until `page.url` differs from the URL before navigating or `page.title` changes, then returns a `read` of the page. The spike showed `browser_navigate` returns before load.
- `read` always sends `snapshot_format: "semantic_v2"`. Without `query` or `ref` it reads the viewport's visible content; output is cut at the existing 12,000 characters (`MAX_TREE_CHARS`, `computer-use-capture.ts:15`) with a hint to pass `query` or `ref`. A full Wikipedia article read was 88,585 characters.
- `read` output is compact text, not cua-driver's JSON: a header `page "<title>" <url>`, the `outline`, then one line per actionable ref `[p5:0] textbox "Name" = "Ada Lovelace" (focused)`. Values are shown except for password fields.
- Page clicks and pointer actions send `delivery_mode: "foreground"`: on Linux Chromium the default background route is refused (`browser_click` description, confirmed in the spike).
- `set_value` with a `ref` on a select maps to `browser_select` with `label` only (it takes exactly one of `label` or `value`).
- `capture` gains `query`, passed to `get_window_state`. A narrowed read returned 938 characters in the spike, and the Wikipedia capture without it was cut before the answer. Works for every app.
- `steps` action: a list of accessibility actions run by `run_steps` in one call, each naming its target by `role`, `name`, optional `nth`, with optional `wait_for` and `expect` checks, then a diff read (`observe`, with `query` when given). `foreground_fallback: true`. Steps cover `click`, `double_click`, `right_click`, `set_value`, `type` (`type_text`), `key` (`press_key`/`hotkey` split as in `pressKey`, `computer-use-actions.ts:173-182`), `scroll`. Page actions are not batchable: `run_steps` only runs accessibility tools.
- cua-driver arguments go through the exec's `env` and the shell's `printf` builtin into stdin (`printf '%s' "$CRUMBLE_DRIVER_ARGS" | cua-driver call <tool>`), for every call. Nothing is written to the guest disk and arguments never show in the process list; `fill_login` needs this, and the rest benefit. `ShellExecOptions` has `env` but no stdin (`node_modules/@earendil-works/pi-durable/dist/env/index.d.ts:237-247`); `cua-driver call` reads JSON from stdin (cua-driver CLI reference, cited in `docs/bot-desktop-research.md`).

## Constraints

- Tests: the scripted guest (`test/fixtures/scripted-guest.ts`) for default tests; VM tests only with `CRUMBLE_VM_TESTS=1`, locally (`src/bot-desktop/desktop-vm.test.ts`). CI unit tests stay under two minutes.
- Check command, from `bot/`: `bun run check`. After changing `apps/docs`, `bun run check` from `apps/docs`.
- Product language follows `GLOSSARY.md` (**Desktop job**, **Bot desktop**). Tool descriptions are model-facing; keep the style of `computer-use.ts:163-170`.
- No HTTP contract change: `computer_use` is a job tool, not an endpoint.

## Out of scope

- A second browser driver (Playwright MCP, Chrome DevTools MCP, agent-browser).
- `browser_dialog`, `browser_download`, `browser_set_input_files`, tabs management, `run_script`.
- Page screenshots through CDP (`include_screenshot` on `get_browser_state`); `capture mode='vision'` stays the screenshot path.
- Logins (`docs/plans/2026-10-29-logins.md`).

## Review focus

1. The owner takes control, switches tabs, and hands back: the next page action acts on the newly active tab (bind per call) and a ref from the old tab is refused, never sent to the wrong page. Test in Task 3.
2. Chromium restarts mid-job (the `browser.sh` loop): the next page action is refused with `browser_consent_required`, attaches again, and says so. Test in Task 3.
3. `open` on a URL that never finishes loading: returns after 10 s with what the page shows and says it may still be loading. Test in Task 3.
4. A `steps` batch whose third step fails: the result names the failed step and its error, and the job is told the earlier steps ran. Test in Task 5.
5. A `read` of a password field shows no value even if cua-driver reports one. Test in Task 3.

## Files

| File | Responsibility |
| --- | --- |
| `apps/server/src/bot-desktop/computer-use-driver.ts` | Arguments through env and stdin. |
| `apps/server/test/fixtures/scripted-guest.ts` | Parse the new call shape; answer the browser tools. |
| `apps/server/src/bot-desktop/computer-use-capture.ts` | `query` on capture. |
| `apps/server/src/bot-desktop/computer-use-page.ts` (new) | Bind, attach, `open`, `read`, ref actions, compact page text. |
| `apps/server/src/bot-desktop/computer-use-steps.ts` (new) | The `steps` action over `run_steps`. |
| `apps/server/src/bot-desktop/computer-use.ts`, `computer-use-run.ts`, `computer-use-actions.ts`, `computer-use-state.ts` | Parameters, dispatch, state (`browserAttached: boolean`). |
| `apps/server/src/jobs/desktop.ts:31-39` | Desktop job instructions. |
| `apps/docs/content/concepts/workspaces.md`, `docs/architecture.md:50`, `CHANGELOG.md` | Docs. |

### Task 1: Driver arguments through stdin

**Files:** modify `src/bot-desktop/computer-use-driver.ts:166-200` (`callDriver`), `test/fixtures/scripted-guest.ts:13,70-80`; test `src/bot-desktop/computer-use.test.ts`.
**Interfaces:** `sh(state, command, context, env?: Record<string, string>)`; `callDriver` runs `printf '%s' "$CRUMBLE_DRIVER_ARGS" | cua-driver call <tool>[ --screenshot-out-file <png>]` with `env: { CRUMBLE_DRIVER_ARGS: JSON.stringify({ session, ...args }) }`. The scripted guest reads arguments from `options.env.CRUMBLE_DRIVER_ARGS`.

- [x] Write the failing test `passes arguments without writing a file`: after one `type` action with `text: "hunter2"`, no `writeFile` call happened and no executed command string contains `hunter2`.
- [x] Run `bun test src/bot-desktop/computer-use.test.ts`. Expected: fails, a `/tmp/computer-use-*.json` file was written.
- [x] Implement; check `sh` passes `env` together with `. /run/crumble-desktop.env` (the guest env file sets `DISPLAY` and the D-Bus address).
- [x] Run `bun test src/bot-desktop` and the VM test (`CRUMBLE_VM_TESTS=1 CRUMBLE_WORKSPACE_IMAGE=crumble-workspace:dev CRUMBLE_WORKSPACE_DESKTOP_IMAGE=crumble-workspace-desktop:dev bun test src/bot-desktop/desktop-vm.test.ts`). Expected: passes.
- [x] Checkpoint: `refactor(desktop): pass cua-driver arguments on stdin`.

### Task 2: Narrowed captures

**Files:** modify `src/bot-desktop/computer-use.ts` (`query` parameter, "capture: only elements matching this text, by role, name, or visible text"), `computer-use-capture.ts:96-110`, `computer-use-run.ts:136-146`; test `computer-use.test.ts`.

- [x] Write the failing test `capture passes query`: the scripted `get_window_state` call has `query: "Born"`, and a query capture doesn't replace the window's diff baseline (a later plain capture still diffs against the last plain one).
- [x] Implement. A query capture never sends `since`.
- [x] Run `bun test src/bot-desktop`. Expected: passes. Checkpoint: `feat(desktop): narrow captures with a query`.

### Task 3: Page binding, `open`, and `read`

**Files:** create `src/bot-desktop/computer-use-page.ts`; modify `computer-use.ts` (enum adds `open`, `read`; parameters `url`, `ref`), `computer-use-run.ts` (dispatch), `computer-use-state.ts`; test `src/bot-desktop/computer-use-page.test.ts`, a case in `desktop-vm.test.ts`.
**Interfaces:**
```ts
type PageBinding = { target_id: string; tab_id: string; url: string; title: string; attachedNow: boolean };
bindPage(state: ComputerUseState, target: Window, context: Context): Promise<PageBinding | { refused: string }>;
openPage(state, args, target, context): Promise<ComputerUseResult>;
readPage(state, args, target, context): Promise<ComputerUseResult>;
pageText(snapshot: SemanticSnapshot): string; // compact text per Decisions
// ComputerUseState gains: browserAttached: boolean; lastRead: Map<string, SemanticSnapshot> (by tab_id, replaced by each read)
```
`SemanticSnapshot` is a zod schema of the fields read: `page.{title,url}`, `outline`, `refs[]`, `content_refs[]` (`ref`, `role`, `name`, `value`, `states`), `snapshot.continuation`, parsed loosely as `driverReply` does (`computer-use-driver.ts:29-54`).

- [x] Write failing tests: `binds and reads the active tab` (bind reply with two tabs, the second active; the snapshot call uses its `tab_id`); `attaches once per session` (first bind refused `browser_consent_required`, one `browser_prepare` with `strategy: {kind: "existing_profile"}`, second bind ok, accessibility snapshots cleared, result mentions the attach; a second action binds without preparing); `open waits for the page` (title `about:blank` twice, then `Den task`: three polls, result is the read); `open gives up after 10 s` (fake timers or an injected clock, result says it may still be loading); `read hides password values`; `read cuts at 12,000 characters with a hint`; `refuses non-Chromium windows` ("open and read work in Chromium only").
- [x] Implement.
- [x] VM test `opens and reads a page`: `open` `http://127.0.0.1:8123/task.html` (python http.server in the guest), `read` with `query: "Name"`; expects a `textbox "Name"` line.
- [x] Run unit tests and the VM test. Expected: passes. Checkpoint: `feat(desktop): open and read pages`.

### Task 4: Page refs on `click`, `type`, `set_value`, `scroll`

**Files:** modify `computer-use-actions.ts` (a `ref` routes to page tools), `computer-use-page.ts`, `computer-use.ts` (`ref` description: "Page element ref like p5:0 from read; use instead of element for web pages."); test `computer-use-page.test.ts`, VM test.
**Interfaces:** `click` with `ref` calls `browser_click {target_id, tab_id, ref, delivery_mode: "foreground"}`; `double_click`/`right_click`/`scroll` call `browser_pointer` with `action` and `delivery_mode: "foreground"` (`scroll` maps `direction` and `amount` to `delta_y`/`delta_x` of `amount * 100` CSS pixels); `type` calls `browser_type {ref, text}`; `set_value` calls `browser_type {ref, text: value, replace: true}`, or `browser_select {ref, label: value}` when the ref's role from the last read is `combobox` or `listbox`. `element` and `ref` together are invalid: "use element or ref, not both".

- [x] Write failing tests for each mapping with the exact driver arguments above, plus `a stale ref returns the refusal` and `capture_after on a ref action returns a read`.
- [x] Implement. `capture_after` with a `ref` returns a `read` (no query) instead of an accessibility capture.
- [x] VM test `fills the form with refs`: the desktop task form by refs, then `read` with `query: "Ada"` shows `Ada Lovelace|Berlin|yes`.
- [x] Run unit tests and the VM test. Expected: passes. Checkpoint: `feat(desktop): act on page refs`.

### Task 5: Batched `steps`

**Files:** create `src/bot-desktop/computer-use-steps.ts`; modify `computer-use.ts` (enum adds `steps`; parameter `steps`), `computer-use-run.ts`; test `src/bot-desktop/computer-use-steps.test.ts`, VM test.
**Interfaces:**
```ts
steps: Type.Optional(Type.Array(Type.Object({
  action: StringEnum(["click", "double_click", "right_click", "set_value", "type", "key", "scroll"]),
  role: Type.Optional(Type.String()), name: Type.Optional(Type.String()), nth: Type.Optional(Type.Integer({ minimum: 0 })),
  text: Type.Optional(Type.String()), keys: Type.Optional(Type.String()), value: Type.Optional(Type.String()),
  direction: Type.Optional(StringEnum(["up", "down", "left", "right"])), amount: Type.Optional(Type.Integer()),
  wait_for: Type.Optional(check), expect: Type.Optional(Type.Array(check, { maxItems: 4 })),
}), { minItems: 1, maxItems: 20 }))
// check = Type.Object({ role?, name?, text?, gone?: boolean, timeout_ms?: integer <= 10000 })
runSteps(state, args, target, context): Promise<ComputerUseResult>;
```
Translated to `run_steps {pid, window_id, foreground_fallback: true, steps: [{ <tool>: {role, name, nth, ...} , wait_for, expect }], observe: { query? } }`. The result: one line per step (`1 click "Submit": ok`, or the error), `stopped at step N` when one failed, then the observed diff compacted like a capture. The observed snapshot becomes the window's baseline in `state.snapshots`.

- [x] Write failing tests: translation of each step kind (exact `run_steps` arguments), `stops at a failed step` (scripted `failed_step: 2`), `observe uses query`, `the observation becomes the diff baseline`.
- [x] Implement.
- [x] VM test `fills the form in one batch`: the Task 4 form via one `steps` call, expecting `Ada Lovelace|Berlin|yes`.
- [x] Run unit tests and the VM test. Expected: passes. Checkpoint: `feat(desktop): batch steps`.

### Task 6: Job instructions and docs

**Files:** modify `src/jobs/desktop.ts:31-39`, `computer-use.ts:163-170` (tool description), `apps/docs/content/concepts/workspaces.md`, `docs/architecture.md:50`, `CHANGELOG.md`; test `src/jobs/desktop.test.ts`.

- [x] Replace the instruction "To open a URL in Chromium: key 'ctrl+l' ..." with: "For web pages, use open (url) and read (query narrows it), and act with ref from the latest read. Use capture and element for Chromium's own menus and dialogs and for other apps. When you know several steps in an app, run them in one steps call with expect checks."
- [x] Update the tool description with `open`, `read`, `ref`, `query`, `steps` in the existing style.
- [x] Docs: one paragraph in `workspaces.md` on how desktop jobs drive web pages; architecture line; changelog line under `## Unreleased`.
- [x] Run `bun run check` from `bot/` and `apps/docs`. Expected: passes. Checkpoint: `docs(desktop): page actions and steps`.
