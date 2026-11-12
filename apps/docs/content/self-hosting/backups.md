---
title: Back Up
description: What to back up, and which keys a restored server needs.
sidebar:
  order: 3
---

A backup of Crumble is a copy of a few directories, plus one key if you use a
master key. Miss the keys and the backup restores, but nothing encrypted in it
can be read.

## What to Back Up

| What               | Where                                    | Why                                                                                              |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| The data directory | `CRUMBLE_DATA_DIR`                       | Accounts, bots, chats, the auth secret (`.auth-secret`), and each account's key (`.secret.key`). |
| Workspace disks    | `MSB_HOME`, `~/.microsandbox` by default | The files in each bot's `/workspace`. Only with Microsandbox.                                    |
| The master key     | Wherever you keep `CRUMBLE_MASTER_KEY`   | Only if you set one. See below.                                                                  |

Include `users/<account>/files/` inside the data directory. It contains library
file bytes and extracted text; `store.sqlite` holds their entries. Back up both
together, not just the database.

Without the account keys, encrypted provider sign-ins and credentials can't be
read.

With [`CRUMBLE_MASTER_KEY`](/self-hosting/configuration#encryption-key) set,
each account's key is stored wrapped in `.secret.key.wrapped`, and a backup of
the data directory alone can't decrypt anything. That's the point. **Back up
the master key separately, away from the data backups.** Without it, the
backups can't be restored.
