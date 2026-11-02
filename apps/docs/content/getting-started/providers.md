---
title: Connect a Model Provider
description: Give your account access to a model with an API key, a provider account, or Claude Code.
sidebar:
  order: 2
---

A bot needs a model provider to answer, and the provider you connect decides
which models your bots can pick. Providers belong to your account, and the
server encrypts their keys and sign-ins with your account's key.

The server ignores provider API keys in its own environment, so
`OPENAI_API_KEY` in your shell does nothing here. All provider settings are in
the web app under **Settings** > **Providers**.

| Method           | Use it when                                             |
| ---------------- | ------------------------------------------------------- |
| API key          | You pay the provider per request.                       |
| Provider account | You already pay for ChatGPT, Codex, Claude, or Copilot. |
| Claude Code      | You have a Claude Pro or Max subscription.              |

## API Keys

Click **Add key** next to the provider, paste the key, and save. To replace or
remove the key later, open the provider's **More** menu.

### Keys in a Password Manager

Instead of storing the key in Crumble, you can read it from 1Password or
Bitwarden Secrets Manager. [Connect the password manager](/concepts/password-managers)
first. Then click **Add key**, or **Replace key** in the provider's **More**
menu, select the password manager, and paste the reference.

Over the API, send `reference` instead of `value` to
`PUT /v1/providers/{provider}`:

```json
{
  "reference": {
    "passwordManager": "1password",
    "reference": "op://Vault/OpenAI/key"
  }
}
```

Crumble reads the reference once to check it. If it can't, it keeps the
previous key. If a model call later can't read the key, the call fails with a
message that names the provider and the password manager's error.

## Provider Accounts

Some providers let you sign in with an account you already have instead of a
key, such as ChatGPT, Codex, Claude, or GitHub Copilot. Click **Sign in** next
to the provider, then **Start sign-in**, and follow the link or code prompt.

Closed the dialog by accident? Click **Continue sign-in** to pick up where you
left off. A sign-in stays open for 10 minutes per prompt and 30 minutes in
total.

## Claude Code

Claude Code lets your bots use a Claude Pro or Max subscription. It runs the
official `claude` command-line tool on the server, so you sign in from the
server's terminal, not from the browser. Any version of `claude` works.

1. Find **Claude Code** in the provider list.
2. Copy the sign-in command it shows and run it on the server.
3. Refresh the provider list.

If the status still says you're signed out, wait a moment: it can take up to
30 seconds to update. To sign out, run the sign-out command shown in the same
place.

Each account gets its own Claude Code sign-in, so two accounts on one server
never share a subscription.

### Claude Code in Docker

The container doesn't ship with `claude`. Install it onto the persistent volume
once:

```bash
docker compose exec crumble sh -c 'mkdir -p /var/lib/crumble/claude-code && cd /var/lib/crumble/claude-code && echo "{\"trustedDependencies\":[\"@anthropic-ai/claude-code\"]}" > package.json && bun add @anthropic-ai/claude-code'
```

Then run the sign-in command inside the container:

```bash
docker compose exec -it crumble sh -c 'PASTE_THE_SIGN_IN_COMMAND_HERE'
```

## Vision Model

Some models can't read images. The vision model reads images for bots that use
one, so you can pick a cheaper or text-only model for a bot and still send it
images. It's off until you choose one in **Settings** > **Vision model**, or
with `PUT /v1/vision-model`. The choices are the models your providers reach
that read images.

| Vision model | A bot whose model can't read images                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Off**      | Refuses images in its bot chat, and gets only each image's name in group chats.                                                                                   |
| **Set**      | Gets the vision model's description of each image, including any visible text, and can ask it follow-up questions about an image. The transcript keeps the image. |

The vision model describes each image once per conversation, and its tokens and
cost count toward the conversation's usage. Bots whose model reads images never
use it.

With a provider connected, [create your first bot](/getting-started/first-bot).
