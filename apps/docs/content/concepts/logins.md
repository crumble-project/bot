---
title: Logins
description: Let a bot's desktop jobs sign in to websites without the bot seeing the password.
sidebar:
  order: 7
---

A login is a username and password, with an optional one-time code, that you
give one bot for a list of hosts. When a desktop job reaches a sign-in page on
one of those hosts, Crumble fills the login into the page. The bot never sees
the password.

Logins and [credentials](/concepts/credentials) solve different problems:

| Kind           | For                          | Does the value enter the workspace?                                 |
| -------------- | ---------------------------- | ------------------------------------------------------------------- |
| **Credential** | API calls from coding jobs   | No. The job only sees a placeholder.                                |
| **Login**      | Sign-in pages in the desktop | Yes. The page holds it once it's filled, as in any browser sign-in. |

## How Filling Works

The desktop job reads the sign-in page, then asks Crumble to fill a field, such
as the password, into one of the page's inputs. Crumble checks the page before
it types anything:

- The page is served over `https`.
- The page's host is one of the login's hosts.
- The field is a text field of the page itself, not of a frame embedded in it.

If any check fails, nothing is typed and the job is told why.

`*.example.com` covers every subdomain of `example.com`, but not `example.com`
itself. If you want both, list both.

A desktop job that finds no login for a sign-in page says so in its answer and
names the host.

Chromium's own password manager is turned off on bot desktops, so it doesn't
save a filled password behind your back.

## What the Bot Sees

The bot and its desktop jobs see each login's name and hosts, never its
values. The password is also replaced in everything the job reads back from
the desktop, such as page text, for as long as the bot exists. While the
browser a password was typed into is still running, the job gets no
screenshots, because a screenshot could show it.

The username and one-time code are less protected. A page that says "Signed in
as ada@example.com" tells the bot the username.

## Adding a Login

Open **Settings** > **Logins**, select **New login**, pick the bot, and fill
in:

| Field             | What to enter                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Name**          | How desktop jobs refer to the login, such as `github`. Lowercase letters, digits, `.`, `_`, and `-`.                    |
| **Hosts**         | The sites the login is for, such as `github.com`.                                                                       |
| **Username**      | The username.                                                                                                           |
| **Password**      | The password.                                                                                                           |
| **One-time code** | Optional. The setup key or `otpauth://totp/` link from the site's two-factor setup. Crumble computes each code from it. |

Values are stored encrypted and never shown again. To change one, enter a new
value. Leave a field empty to keep the saved one.

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

Send `"one_time_code": null` to remove a login's one-time code.
`GET /v1/agents/{id}/logins` lists a bot's logins, without values.

## When a Bot Asks for a Login

When a desktop job reaches a sign-in page that no login covers, the bot can ask
you for one. The request shows up as a card in the bot chat with the login's
name and hosts, and under **Waiting for you** in **Settings** > **Logins** with
the bot's reason.

Select **Add login** to fill it in, or **Decline**. Either way, the bot gets a
message and takes a turn.

**Check the hosts the bot proposed before you save.** The login is filled only
into pages on them, and they're the bot's guess, not yours.

Over the API, the request is listed under `requests` in
`GET /v1/agents/{id}/logins`. Saving a login with the same name answers it, and
`POST /v1/agents/{id}/logins/{name}/decline` declines it.

## Logins in a Password Manager

Each field can come from a [password manager](/concepts/password-managers)
instead of being stored in Crumble. Select the password manager above the
field and paste a reference:

| Password manager | Reference                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1Password        | A reference to the field, such as `op://Private/GitHub/password`.                                                                                                                                                        |
| 1Password item   | Select **1Password item** at the top of the editor and give the item, such as `op://Private/GitHub`. It fills the username, the password, and the one-time code if the item has one. 1Password computes the code itself. |
| Bitwarden        | One secret ID per field. A one-time code's secret holds the setup key or `otpauth://totp/` link.                                                                                                                         |

Over the API, send
`{"reference": {"passwordManager": "1password", "reference": "op://..."}}` for a
field, or
`"item": {"passwordManager": "1password", "reference": "op://Private/GitHub"}`
instead of `fields`.

Crumble reads every reference once when you save, and saves nothing if one
can't be read.

## Fills

Every fill is recorded for 90 days: when, which field, on which host, and why
the value couldn't be read, if it couldn't. Open a login's **More** menu and
select **Fills** to see them, or call `GET /v1/agents/{id}/logins/{name}/uses`.
A login's row shows when it was last filled, or the newest error.
