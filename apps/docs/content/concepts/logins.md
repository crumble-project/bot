---
title: Logins
description: Let a bot's desktop jobs sign in to websites without the bot seeing the password.
sidebar:
  order: 7
---

A login is a username and password, with an optional one-time code, that you give one bot for a list of hosts. When a desktop job reaches a sign-in page on one of those hosts, it fills the login's fields into the page. The bot never sees the password.

Unlike a [credential](/concepts/credentials), a login's values enter the bot desktop: the page holds them once they're filled, as in any browser sign-in.

## How filling works

The desktop job reads the sign-in page, then asks Crumble to fill a field, such as the password, into one of the page's input fields. Crumble checks the page first and types the value only when:

- The page is served over `https`.
- The page's host is one of the login's hosts. `*.example.com` covers every subdomain of `example.com`, but not `example.com` itself.
- The field is a text field of the page itself, not of a frame embedded in it.

If any check fails, nothing is typed and the job is told why. A desktop job that finds no login for a sign-in page says so in its answer, naming the host.

Chromium's own password manager is turned off on bot desktops, so it doesn't save a filled password.

## What the bot sees

The bot and its desktop jobs see each login's name and hosts, never its values. The password is also replaced in everything the job reads back from the desktop, such as page text, for as long as the bot exists. While the browser a password was typed into is still running, the job gets no screenshots, because a screenshot could show it.

A username or one-time code can reach the bot, for example when a page shows "Signed in as ada@example.com".

## Add a login

Open **Settings** > **Logins**, select **New login**, pick the bot, and enter:

- **Name**: how desktop jobs refer to the login, such as `github`. Lowercase letters, digits, `.`, `_`, and `-`.
- **Hosts**: the sites the login is for, such as `github.com`.
- **Username** and **Password**.
- **One-time code**, if the site asks for a two-factor code. Paste the setup key or the `otpauth://totp/` link from the site's two-factor setup, and Crumble computes each code from it.

Values are stored encrypted and never shown again. To change one, enter a new value; leave a field empty to keep the saved one.

Over the API, send the login to `PUT /v1/agents/{id}/logins/{name}`:

```json
{
  "hosts": ["github.com"],
  "fields": {
    "username": { "value": "ada@example.com" },
    "password": { "value": "..." },
    "one_time_code": { "value": "JBSWY3DPEHPK3PXP" }
  }
}
```

Send `"one_time_code": null` to remove a login's one-time code. `GET /v1/agents/{id}/logins` lists a bot's logins, without values.

## When a bot asks for a login

When a desktop job reaches a sign-in page that no login covers, it says so in its answer, and the bot can ask you for a login. The request shows up as a card in the bot chat, with the login's name and hosts, and under **Waiting for you** in **Settings** > **Logins**, with the bot's reason.

Select **Add login** to fill in the login, or **Decline**. Either way, the bot gets a message and takes a turn. Check the hosts the bot proposed before you save: the login is filled only into pages on them.

Over the API, the request is listed under `requests` in `GET /v1/agents/{id}/logins`. Saving a login with the same name answers it. `POST /v1/agents/{id}/logins/{name}/decline` declines it.

## Read a login from a password manager

Each field can come from a [password manager](/concepts/password-managers) instead of being stored in Crumble. Select the password manager above the field and paste a reference:

- **1Password**: a reference to the field, such as `op://Private/GitHub/password`. Or select **1Password item** at the top of the editor and give the item, such as `op://Private/GitHub`. The item fills the username, the password, and the one-time code, if the item has one. 1Password computes the code itself.
- **Bitwarden**: one secret ID per field. A one-time code's secret holds the setup key or `otpauth://totp/` link.

Over the API, send `{"reference": {"passwordManager": "1password", "reference": "op://..."}}` for a field, or `"item": {"passwordManager": "1password", "reference": "op://Private/GitHub"}` instead of `fields`.

Crumble reads every reference once when you save, and saves nothing if one can't be read.

## Fills

Every fill is recorded for 90 days: when, which field, on which host, and why the value couldn't be read, if it couldn't. Open a login's **More** menu and select **Fills** to see them, or call `GET /v1/agents/{id}/logins/{name}/uses`. A login's row shows when it was last filled, or the newest error.
