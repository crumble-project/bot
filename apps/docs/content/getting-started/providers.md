---
title: Connect a model provider
description: Give your account access to a model with an API key, a provider account, or Claude Code.
sidebar:
  order: 2
---

Bots need a model provider to answer. Providers belong to your account, and the server encrypts their keys and sign-ins with your account's key. The server ignores provider API keys set in its own environment.

All provider settings are in the web app under **Settings** > **Providers**.

## Add an API key

1. Click **Add key** next to the provider.
2. Paste the key and save.

To replace or remove a saved key, open the provider's **More** menu.

### Read the key from a password manager

Instead of storing the key in Crumble, you can read it from 1Password or Bitwarden Secrets Manager. Connect the password manager first, as described in [Password managers](/concepts/password-managers). Then click **Add key**, or **Replace key** in the provider's **More** menu, select the password manager, and paste the reference. Over the API, send `reference` instead of `apiKey` to `PUT /v1/providers/{provider}`:

```json
{
  "reference": {
    "passwordManager": "1password",
    "reference": "op://Vault/OpenAI/key"
  }
}
```

Crumble reads the reference once to check it and keeps the previous key if the reference can't be read. A model call that can't read the key fails with a message that names the provider and the password manager's error.

## Sign in with a provider account

Some providers let you sign in with an existing account instead of a key, for example ChatGPT, Codex, Claude, or GitHub Copilot.

1. Click **Sign in** next to the provider.
2. Click **Start sign-in** and follow the link or code prompt.

If you close the dialog, click **Continue sign-in** to pick up where you left off. A sign-in stays open for 10 minutes per prompt and 30 minutes in total.

## Use a Claude subscription

Claude Code lets your bots use a Claude Pro or Max subscription. It runs the official `claude` command-line tool on the server, so you sign in from the server's terminal, not from the browser. Crumble is tested against `claude` version `2.1.309`.

1. Find **Claude Code** in the provider list.
2. Copy the sign-in command it shows and run it on the server.
3. Refresh the provider list. The status can take up to 30 seconds to update.

To sign out, run the sign-out command shown in the same place.

Each account gets its own Claude Code sign-in, so two accounts on one server never share a subscription.

### Claude Code in Docker

Install the CLI onto the persistent volume once:

```bash
docker compose exec crumble sh -c 'mkdir -p /var/lib/crumble/claude-code && cd /var/lib/crumble/claude-code && echo "{\"trustedDependencies\":[\"@anthropic-ai/claude-code\"]}" > package.json && bun add @anthropic-ai/claude-code@2.1.309'
```

Then run the sign-in command inside the container:

```bash
docker compose exec -it crumble sh -c 'PASTE_THE_SIGN_IN_COMMAND_HERE'
```

## Next step

[Create your first bot](/getting-started/first-bot).
