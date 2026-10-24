# Railway sandboxes as a workspace backend

- Status: Accepted

Workspaces run on Microsandbox, which needs `/dev/kvm` or Apple silicon, so the server cannot run on a host without
virtualization, such as Railway itself. Railway Sandboxes are VMs Railway hosts. Research and spike results:
[docs/research/railway-sandboxes.md](../research/railway-sandboxes.md).

## Decision

Railway is a second backend behind `Workspaces`, chosen with `CRUMBLE_WORKSPACE_BACKEND=railway`. Microsandbox stays.

- **One lifecycle, two backends.** `MachineWorkspaces` (`src/machine-workspaces.ts`) owns what both share: lazy boot,
  idle stop, holds, image choice per bot, and the pi-env relay. A backend implements `WorkspaceMachines.boot` and a
  `WorkspaceMachine`: liveness, a byte stream to a guest program, sync, and stop.
- **Files live in a checkpoint.** Railway has no volumes. A bot's disk survives as the checkpoint
  `crumble-<user id>-<bot id>`, taken before every stop. A guest `sync` runs first, since a checkpoint does not flush the page cache.
- **`sync` schedules, it does not wait.** Coding jobs sync after every file-changing tool call, and a checkpoint takes
  5 to 9 seconds. A sync schedules one after 30 seconds without another. A server that dies leaves the sandbox
  running; the next server reconnects to it through the sandbox id recorded in
  `<data dir>/workspaces/railway/<bot id>.json`. Writes are lost only when the sandbox dies too before a checkpoint.
- **Railway's idle timeout is 30 minutes**, kept off by a heartbeat every 10 seconds while the workspace runs. It ends
  sandboxes of a server that died and never came back. The heartbeat also notices a sandbox Railway destroyed and ends
  its streams, which do not end by themselves.
- **Images are template recipes** named by their hash. A bot whose checkpoint has another image gets a new sandbox
  from the current template, with `/workspace` copied over as a tarball through Railway's file transfer.
- **Exec output is text,** so a guest helper (`src/railway-stream.py`) sends a program's stdout as base64 lines.
- **No network policy.** Railway has no egress hook, so `WorkspaceNetworkPolicy` does not apply. Sandboxes are
  `ISOLATED`: internet only, not the Railway environment's private network. The owner accepted losing network-level
  approval on 2026-10-23; approvals for push or PR belong in the tool layer.
- **Bot desktops run in a second template** with the Dockerfile's desktop packages, cua-driver, and a pinned
  Chromium snapshot build: Ubuntu ships Chromium only as a snap, which a sandbox cannot run, and Playwright's browser
  is now Chrome for Testing. The desktop scripts upload at every boot. VNC goes over the same exec stream as pi-env,
  through `socat` in the guest. A bot gaining or losing the desktop moves to the other template with its `/workspace`.

## Consequences

- The server runs anywhere, Railway included, at Railway's per-second price for running sandboxes.
- A call in flight when Railway loses a sandbox fails; the next call boots from the checkpoint.
- Coding work depends on a vendor again. The `WorkspaceMachines` seam keeps Microsandbox as the alternative.
