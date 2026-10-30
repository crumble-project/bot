---
title: Password managers
description: Read credentials, provider API keys, and MCP server tokens from 1Password or Bitwarden instead of storing them in Crumble.
sidebar:
  order: 8
---

A password manager holds secrets that Crumble reads when it needs them, instead of storing them itself. Crumble supports 1Password and Bitwarden Secrets Manager. Four kinds of secrets can come from one:

- A bot's [credential](/concepts/credentials).
- A field of a bot's [login](/concepts/logins).
- A [model provider's](/getting-started/providers) API key.
- An [MCP server's](/concepts/schedules-and-integrations#mcp-integrations) bearer token.

Crumble only reads from a password manager. It never writes or changes a secret there.

## Connect a password manager

1. Create a token that can read the secrets Crumble needs:
   - In 1Password, a service account token with read access to the vaults that hold them.
   - In Bitwarden Secrets Manager, a machine account access token with read access to their projects.
2. In the web app, open **Settings** > **Password managers** and select **Connect** next to the password manager.
3. Paste the token and select **Connect**.

Crumble signs in once to check the token, then stores it encrypted with your account's key. To change it, open the row's **More** menu and select **Replace token**. Values read with the old token are dropped.

Over the API, send `{"token": "..."}` to `PUT /v1/password-managers/{id}`, where `{id}` is `1password` or `bitwarden`.

## Point a secret at it

In the editor for a credential, a provider's API key, or an MCP server's token, select the password manager above the value field instead of **Crumble**, then paste a reference:

| Password manager | Reference                                                   |
| ---------------- | ----------------------------------------------------------- |
| 1Password        | A secret reference, such as `op://Private/Acme/credential`. |
| Bitwarden        | The secret's ID.                                            |

Crumble reads the reference once when you save and rejects the save if it can't read it. Nothing changes until it can.

## When Crumble reads a secret

Crumble reads a secret only when something uses it, such as a request with a credential's placeholder or a model call. It keeps the value in memory, never on disk:

- For an hour after a read, the value is used without asking the password manager again. After 55 minutes, a use also refreshes it in the background.
- If the password manager can't be reached, a value read in the last two hours is still used.
- If the password manager answers that the secret is gone or that the token can't read it, Crumble drops the value right away.

Changing or removing a secret's reference drops its value too.

## When a secret can't be read

What happens depends on the kind of secret:

- **Credential**: the server doesn't send the request and answers it with an error that names the credential. The credential's row in **Settings** > **Credentials** shows the newest such error.
- **Login**: nothing is typed, and the desktop job is told the value couldn't be read. The login's row in **Settings** > **Logins** shows the newest such error.
- **Provider API key**: the model call fails with an error that names the provider and the password manager's message.
- **MCP server token**: the bot answers without that server's tools, and the server's entry in **Integrations** shows why.

## Disconnect

Open the row's **More** menu and select **Disconnect**. While any secret reads from the password manager, **Disconnect** is unavailable and the row shows how many do, for example **(used by 3)**. Switch those secrets to **Crumble** or another reference first.
