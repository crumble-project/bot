---
title: Credentials
description: Let a bot's coding jobs use an API key without the key entering the workspace.
sidebar:
  order: 6
---

A credential is a secret you give one bot for a list of hosts, like an API token for `api.example.com`. The bot's coding jobs can use it, but the real value never enters the workspace.

## How it works

The coding job sees a random placeholder in an environment variable, for example `$ACME_TOKEN`. When the job sends an HTTPS request to one of the credential's hosts, the server swaps the placeholder for the real value on the way out and removes the value from the response on the way back. Requests to any other host get only the placeholder.

To let a desktop job sign in to a website, give the bot a [login](/concepts/logins) instead. A placeholder can't sign in through a page, because the page's own scripts read and send the password.

The placeholder is swapped only in request headers, such as `Authorization` or `X-Api-Key`. A placeholder in the URL or the body is sent as it is, because services log, store, and echo URLs and bodies, which would let a job read the value back. An API that takes its key only as a query parameter can't use a credential.

## Give each credential the least access it needs

The bot can do anything the credential allows on its hosts: the placeholder keeps the value out of the workspace, not the bot away from the API. Give a bot a token scoped to the work you want from it, such as a read-only token or one limited to a single repository, rather than a full-access key.

Every use is logged for 90 days.

## Add a credential

Open **Settings** > **Credentials**, select **New credential**, pick the bot, and add the secret with the hosts it's for.

A bot can also ask you for a credential when it needs one. The request shows up as a card in the bot chat. Enter the value or decline the request there, or answer it under **Waiting for you** in **Settings** > **Credentials**.

The value never appears in the transcript, notices, or logs.

## Read the value from a password manager

Instead of storing the value in Crumble, a credential can read it from 1Password or Bitwarden Secrets Manager. [Connect the password manager](/concepts/password-managers), then select it above **Value** in the credential's editor and paste the reference.

Over the API, send `reference` instead of `value` to `PUT /v1/agents/{id}/credentials/{name}`:

```json
{
  "hosts": ["api.example.com"],
  "reference": {
    "passwordManager": "1password",
    "reference": "op://Private/Acme/credential"
  }
}
```

When the value can't be read, the server doesn't send the request and records why in the credential's uses. The credential's row shows the newest such error, and the API returns it as `lastError`.
