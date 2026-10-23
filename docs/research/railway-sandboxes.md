# Railway Sandboxes as a workspace backend

Status: research and spike, 2026-10-23. Spike code: `crumble-project/spikes/railway`. Coding jobs are built: [ADR 0005](../adr/0005-railway-workspaces.md).

## Question

Can Railway Sandboxes replace or sit next to Microsandbox as the machine behind `Workspaces`
(`src/workspace.ts`) for coding jobs, and later for desktop jobs?

Why it matters: Microsandbox needs `/dev/kvm`, which moved the server off Railway onto a KVM host. With the VM
hosted by Railway, the server could run on any host again, Railway included.

## Sources

- [Sandboxes reference](https://docs.railway.com/sandboxes)
- [Code-execution sandboxes guide](https://docs.railway.com/guides/code-execution-sandboxes)
- [Changelog #0308: GA](https://railway.com/changelog/2026-09-18-railway-sandboxes), generally available on every plan
- Type declarations of the `railway` npm package 3.16.0 (`dist/index.d.ts`), Node 22 or later. It runs under Bun 1.4.
- Auth: `RAILWAY_TOKEN` (project token, sent as `project-access-token`) or `RAILWAY_API_TOKEN`. Sandboxes also need
  `RAILWAY_ENVIRONMENT_ID`; a project token reports its own with the GraphQL query
  `projectToken { projectId environmentId }`.

## What Railway offers

- Isolated Linux VMs, Ubuntu base with git, Node, Pi, Claude Code, Codex. Custom images only via
  `Sandbox.template()` (`run`, `withPackages`, `workdir`), cached by content hash. No Dockerfile or OCI image.
- `exec(cmd, { cwd, env, stdin, ephemeral, timeoutSec, signal, onStdout, onStderr })`. Kill and abort signal the
  process group, TERM then KILL after 5 s. `onStdout` delivers `string` chunks, not bytes.
- `files`: read, write (streams), list, stat, mkdir, rename, remove.
- No persistent volume. Disk survives only as a named checkpoint (`checkpoint(name)`, `Sandbox.create(name)`):
  files kept, processes and memory not. The idle timeout destroys the sandbox.
- Idle timeout: Hobby and Pro 1-120 min or `0` for never; Trial and Free at most 5 min.
- Network: `ISOLATED` (default, internet only) or `PRIVATE` (joins the environment's private network). HTTP domains
  only in `PRIVATE`. No egress allowlist, proxy, or hook. No raw TCP exposure.
- Limits: Hobby up to 8 vCPU / 8 GB, 50 sandboxes per environment; Pro up to 32 / 32, 100.
- Price: $50 per GB of memory per month and $50 per vCPU per month, per second while running; egress $0.05/GB.
  Example: a 4 GB, 2 vCPU workspace busy 2 hours a day costs roughly $25 a month.

## Mapping onto `Workspaces`

| `Workspaces` member | Railway | Fit |
|---|---|---|
| `env(agentId)` | Run the pi-env daemon with `exec(daemon, { stdin: true, ephemeral: true, onStdout })` and keep the existing bridge and relay. | Verified: 29/29 conformance. pi-env frames are binary, so a guest wrapper (`guest-wrap.mjs`) base64-encodes stdout lines. |
| Files survive machine stop | Our idle stop checkpoints `crumble-<agentId>`, then destroys. Boot creates from that checkpoint. | Workable. Writes since the last checkpoint are lost if the server dies, as with a hard kill today. |
| `sync` | `checkpoint(name)` | 4.6 s for a small change, 8.8 s for a first one; too slow per write, fine on idle stop and job end. Storage price UNKNOWN. |
| `restart` | Checkpoint, destroy, create from checkpoint (on the new template if the image changed). | Good. Image change carries files across, unlike a qcow2 tied to its image. |
| `keepAwake` | Our own timer plus `heartbeat()`; Railway idle timeout set to `0` or above ours. | Good on Hobby and Pro. Trial and Free cannot hold a machine past 5 idle minutes. |
| `openDesktop` | No raw TCP. Either an exec stream (`socat` to `127.0.0.1:5900`, base64 framed because stdout is text) or a public HTTPS domain with websockify, which needs `PRIVATE`. | Verified with the exec stream (`guest-tcp.mjs`): Xvnc answers `RFB 003.008` through it, exact bytes, about 2.4 MiB/s sustained. |
| `WorkspaceNetworkPolicy` | Nothing to attach it to. | Gap, see below. |

## Gaps and risks

1. Egress control. Microsandbox sends every connection through `workspace-proxy.ts`, which blocks private ranges
   and calls the network policy. Railway has no egress hook; `ISOLATED` keeps the sandbox off the private network.
   Owner decision 2026-10-23: losing network-level approval is acceptable. Approvals for push and PR move to the tool
   layer when they come.
2. Credentials. With no host-side injection, any token a coding job needs lives inside the VM.
3. Vendor dependency. Choosing Microsandbox was about "isolation without a vendor"; this backend reintroduces one.
   Keeping Microsandbox as the second implementation behind `Workspaces` limits the lock-in.
4. A crashed server leaves sandboxes running until Railway's idle timeout. The backend must find them again on start
   (store the sandbox id per bot, `Sandbox.connect(id)`), or a never-idle setting bills forever.
5. Desktop: Ubuntu is glibc, so cua-driver works. Xvnc, Openbox, tint2, and Chromium go into a template. Base64 adds
   a third more bytes; throughput is not the limit, the round trip to us-west2 is.
6. Latency. From the owner's machine every exec costs about 850 ms and a stream round trip about 175 ms, because
   sandboxes run in us-west2 by default. A server hosted near the region removes most of it; `region` is settable.
7. Guest helpers must not call `process.exit` while stdout is unflushed: it silently drops output (found in the spike).

## Spike results

Run 2026-10-23 from macOS against us-west2, 2 vCPU and 2 GB sandboxes.

| Measurement | Result |
|---|---|
| Base image | Ubuntu 26.04, x86_64, root, 29 GB disk; node and python via mise, git; no socat |
| Create | 2.3 s fresh, 4.7 s from template or checkpoint |
| One exec | about 850 ms |
| Binary stdin | bytes 0-255 arrive intact |
| Exec stdout | 200k numbered lines, no loss, no repeats |
| Durable env conformance | 29/29 (twice) |
| Workspace of 387 MB, 12k files | checkpoint 8.8 s, next checkpoint 4.6 s, restore 4.7 s, every file back |
| Template with Xvnc and Openbox | 98 s first build, 0.2 s cached |
| VNC over exec stream | RFB banner in about 1 s; echo round trip median 175 ms |
| Stream throughput | 16 MiB in 3.6 s, 64 MiB in 26.7 s, exact bytes |

## Next steps

1. Bot desktops on Railway: a template with the desktop packages and a Chromium that is not a snap, then
   `openDesktop` over the exec stream. Needs the desktop VM tests ported to Railway.
