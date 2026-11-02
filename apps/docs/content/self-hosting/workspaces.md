---
title: Set Up Workspaces
description: Run bot workspaces on Microsandbox on your own hardware, or on Railway.
sidebar:
  order: 2
---

Coding jobs and bot desktops run in [workspaces](/concepts/workspaces), and the
backend you pick decides whose hardware they run on.

| Backend                | Runs on                                                 | Needs                                          |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| Microsandbox (default) | The server's own hardware, one microVM per bot          | Apple silicon on macOS, or `/dev/kvm` on Linux |
| Railway                | [Railway sandboxes](https://docs.railway.com/sandboxes) | A Railway Hobby or Pro plan                    |

Without either backend, bots still chat, but can't start coding jobs or use a
desktop.

## Microsandbox

Start the server with the published workspace images, using the same version
as your server:

```bash
CRUMBLE_WORKSPACE_IMAGE=ghcr.io/crumble-project/crumble-workspace:0.5.0 \
CRUMBLE_WORKSPACE_DESKTOP_IMAGE=ghcr.io/crumble-project/crumble-workspace-desktop:0.5.0 \
bun run start
```

`CRUMBLE_WORKSPACE_IMAGE` enables coding jobs. `CRUMBLE_WORKSPACE_DESKTOP_IMAGE`
adds bot desktops.

From a checkout, `bun run dev` selects the published `:main` coding and
desktop images for you. Microsandbox downloads each image the first time it's
needed. You can override either variable, or set it to an empty string to turn
that image off.

Workspace disks live in `MSB_HOME`, which defaults to `~/.microsandbox`.
Include it in your [backups](/self-hosting/backups).

### Network

Workspaces reach the network over TCP through Crumble's proxy.

Outbound UDP is blocked, except DNS, so HTTP/3 and other UDP traffic can't
bypass the proxy. Upgrading recreates machines made before this rule. Files in
`/workspace` are kept, but programs installed anywhere else are not.

### Docker on Linux

Add `compose.kvm.yaml`, and pass the KVM group and the workspace image:

```bash
CRUMBLE_KVM_GID=$(getent group kvm | cut -d: -f3) \
CRUMBLE_WORKSPACE_IMAGE=ghcr.io/crumble-project/crumble-workspace:0.5.0 \
docker compose -f compose.yaml -f compose.kvm.yaml up -d --build
```

### Building the Images Yourself

Build from `apps/server/workspace-image/Dockerfile` and load the image into
Microsandbox:

```bash
docker build --target base -t crumble-workspace:dev apps/server/workspace-image
docker save crumble-workspace:dev -o /tmp/crumble-workspace.tar
bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/crumble-workspace.tar", { tag: "crumble-workspace:dev" })'
```

For the desktop image, use `--target desktop` and the tag
`crumble-workspace-desktop:dev`. It adds the bot desktop: Xvnc, the XFCE
window manager and panel, Thunar, the XFCE terminal, Chromium, and
`cua-driver`, started by `/opt/crumble/desktop-start.sh`.

## Railway

Railway workspaces need no virtualization on the server. Set:

```bash
CRUMBLE_WORKSPACE_BACKEND=railway
RAILWAY_TOKEN=...            # a project token, or set RAILWAY_API_TOKEN instead
RAILWAY_ENVIRONMENT_ID=...
CRUMBLE_RAILWAY_REGION=...   # optional
```

Railway enables both coding jobs and bot desktops. It differs from
Microsandbox in a few ways:

| Topic         | On Railway                                                              |
| ------------- | ----------------------------------------------------------------------- |
| Plan          | Use Hobby or Pro. Other plans delete idle sandboxes after 5 minutes.    |
| Network       | Outbound connections from workspaces aren't filtered.                   |
| Node          | The version Railway's Ubuntu comes with, not the image's pinned LTS.    |
| Saving files  | A checkpoint 30 seconds after the last change, and before every stop.   |
| First desktop | Takes a few minutes to start while Railway builds the desktop template. |

## Workspace Settings

Admins set these for every workspace on the server in **Settings** >
**Coding**, under **Workspaces**. That section also says when the server lacks
the image for coding jobs or bot desktops.

| Setting               | Default                   | Applies                                                                      |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| Workspace size        | 2 CPUs, 4 GB              | When a workspace's machine is next created. A running one keeps its size.    |
| Coding image          | `CRUMBLE_WORKSPACE_IMAGE` | Microsandbox only. Railway builds its own images and ignores this setting.   |
| Question grace period | 15 minutes                | How long a coding job that asked you a question keeps its workspace running. |

A new coding image never replaces a machine while it works. Each running
workspace switches at its next idle stop, keeping `/workspace`, and a stopped
one switches when it next starts. `GET /v1/admin/workspaces/outdated` lists the
ones still on an older image. Bots with a bot desktop keep using
`CRUMBLE_WORKSPACE_DESKTOP_IMAGE`.

The image needs what the published one has: Debian with git, curl, and
`ca-certificates`. The server writes its own helpers into every workspace when
it starts, and sets `vm.overcommit_memory` to `1`, so tools that reserve more
memory than the machine has, such as oxlint, don't crash. A machine that
refuses the setting still starts, and the server logs a warning.
