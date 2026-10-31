---
title: Back Up and Migrate
description: What to back up, and how to move data from a single-user server into an account.
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

Without the account keys, encrypted provider sign-ins and credentials can't be
read.

With [`CRUMBLE_MASTER_KEY`](/self-hosting/configuration#encryption-key) set,
each account's key is stored wrapped in `.secret.key.wrapped`, and a backup of
the data directory alone can't decrypt anything. That's the point. **Back up
the master key separately, away from the data backups.** Without it, the
backups can't be restored.

## Moving Single-User Data Into an Account

Older single-user servers kept data at the root of `CRUMBLE_DATA_DIR`. The
current server never hands that data to whoever signs up first, so you assign
it to an account yourself:

1. Stop the old server, and back up the data directory and `MSB_HOME`.
2. Start the current server with the same `CRUMBLE_DATA_DIR`.
3. Create the owner's account from the command line. **Don't open the web app
   first**: opening it creates an empty account.

   ```bash
   curl --fail-with-body http://127.0.0.1:7337/api/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     --data '{"email":"OWNER_EMAIL","name":"OWNER_NAME","password":"OWNER_PASSWORD"}'
   ```

4. Stop the server.
5. Assign the data:

   ```bash
   CRUMBLE_DATA_DIR=./data bun apps/server/tools/assign-legacy-owner.ts OWNER_EMAIL
   ```

   With Docker:

   ```bash
   docker compose stop crumble
   docker compose run --rm crumble bun apps/server/tools/assign-legacy-owner.ts OWNER_EMAIL
   ```

6. Start the server and sign in.

The tool copies the data and keeps the originals. It refuses to run while the
server is running, to run twice, or to overwrite an account that already has
data.

The old server token stops working. Sign in with the account instead.

Workspace files don't move on their own. Old Microsandbox disks are named
`crumble-BOT_ID` and new ones `crumble-USER_ID-BOT_ID`. Copy files from the old
disk to the new one if you need them.
