---
title: Credentials
description: Let a bot's coding jobs use an API key without the key entering the workspace.
sidebar:
  order: 6
---

A credential is a secret you give one bot for a list of hosts, like an API token for `api.example.com`. The bot's coding jobs can use it, but the real value never enters the workspace.

## How it works

The coding job sees a random placeholder in an environment variable, for example `$ACME_TOKEN`. When the job sends an HTTPS request to one of the credential's hosts, the server swaps the placeholder for the real value on the way out and removes the value from the response on the way back. Requests to any other host get only the placeholder.

Every use is logged for 90 days.

## Add a credential

Open **Settings** > **Credentials**, select **New credential**, pick the bot, and add the secret with the hosts it's for.

A bot can also ask you for a credential when it needs one. The request shows up as a card in the bot chat. Enter the value or decline the request there, or answer it under **Waiting for you** in **Settings** > **Credentials**.

The value never appears in the transcript, notices, or logs.

## Read the value from a password manager

Instead of storing the value in Crumble, a credential can point at a secret in 1Password or Bitwarden Secrets Manager. The web app doesn't offer this yet; use the API.

1. Connect the password manager with `PUT /v1/password-managers/{id}`, where `{id}` is `1password` or `bitwarden`, and send `{"token": "..."}`: a 1Password service account token or a Bitwarden access token. Crumble signs in once to check it.
2. Save the credential with `PUT /v1/agents/{id}/credentials/{name}` and send `reference` instead of `value`:

   ```json
   {
     "hosts": ["api.example.com"],
     "reference": {
       "passwordManager": "1password",
       "reference": "op://Vault/Item/field"
     }
   }
   ```

   A Bitwarden reference is the secret's ID.

Crumble reads the reference once when you save it and rejects the save if it can't be read. After that, it reads the value only when a request uses the credential, and keeps it in memory for an hour. If the password manager can't be reached, a value read in the last two hours is still used.

When the value can't be read, the server doesn't send the request and records why in the credential's uses. The credential's `lastError` shows the newest such error.

A password manager can't be disconnected while a credential still reads from it. Save a value instead, or delete the credential, first.
