---
title: Set up workspaces
description: Run bot workspaces on Microsandbox on your own hardware, or on Railway.
sidebar:
  order: 2
---

Coding jobs and bot desktops run in [workspaces](/concepts/workspaces). Choose where they run:

| Backend                | Runs on                                                 | Needs                                          |
| ---------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| Microsandbox (default) | The server's own hardware, one microVM per bot          | Apple silicon on macOS, or `/dev/kvm` on Linux |
| Railway                | [Railway sandboxes](https://docs.railway.com/sandboxes) | A Railway Hobby or Pro plan                    |

Without either, bots still chat, but can't start coding jobs or use a desktop.

## Microsandbox

For development from a checkout, `bun run dev` selects the published `:main`
coding and desktop images automatically. Microsandbox downloads each image when
it is first needed. You can override either image variable, or set it to an
empty string to disable that image.

Start the server with the published workspace images. Use the same version as your server:

```bash
CRUMBLE_WORKSPACE_IMAGE=ghcr.io/crumble-project/crumble-workspace:0.1.0 \
CRUMBLE_WORKSPACE_DESKTOP_IMAGE=ghcr.io/crumble-project/crumble-workspace-desktop:0.1.0 \
bun run start
```

`CRUMBLE_WORKSPACE_IMAGE` enables coding jobs. Add `CRUMBLE_WORKSPACE_DESKTOP_IMAGE` for bot desktops too.

Workspace disks live in `MSB_HOME`, which defaults to `~/.microsandbox`. Include it in your [backups](/self-hosting/backups).

### With Docker on Linux

Add `compose.kvm.yaml` and pass the KVM group and the workspace image:

```bash
CRUMBLE_KVM_GID=$(getent group kvm | cut -d: -f3) \
CRUMBLE_WORKSPACE_IMAGE=ghcr.io/crumble-project/crumble-workspace:0.1.0 \
docker compose -f compose.yaml -f compose.kvm.yaml up -d --build
```

### Build the images yourself

Build from `apps/server/workspace-image/Dockerfile` and load the image into Microsandbox:

```bash
docker build --target base -t crumble-workspace:dev apps/server/workspace-image
docker save crumble-workspace:dev -o /tmp/crumble-workspace.tar
bun -e 'import { Image } from "microsandbox"; await Image.load("/tmp/crumble-workspace.tar", { tag: "crumble-workspace:dev" })'
```

For the desktop image, use `--target desktop` and the tag `crumble-workspace-desktop:dev`.

## Railway

Railway workspaces need no virtualization on the server. Set:

```bash
CRUMBLE_WORKSPACE_BACKEND=railway
RAILWAY_TOKEN=...            # a project token, or set RAILWAY_API_TOKEN instead
RAILWAY_ENVIRONMENT_ID=...
CRUMBLE_RAILWAY_REGION=...   # optional
```

Railway enables both coding jobs and bot desktops.

- Use a Hobby or Pro plan. Other plans delete idle sandboxes after 5 minutes.
- Railway doesn't filter outbound connections from workspaces.
- A bot's files are saved as a checkpoint 30 seconds after the last change and before every stop.
- The first bot desktop takes a few minutes to start while Railway builds the desktop template.
