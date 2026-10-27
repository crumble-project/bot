---
title: Configuration
description: Environment variables for the Crumble server, and what to set before exposing it to a network.
sidebar:
  order: 1
---

Configure the server with environment variables.

## Expose the server

The server listens on `127.0.0.1` and has open registration, so anyone who can reach it can create an account. To use it from other devices:

1. Put the server behind a reverse proxy that serves HTTPS.
2. Set `CRUMBLE_PUBLIC_URL` to the public `https://` address. Sign-in fails through a proxy or another hostname without it.

## Passkeys

Passkeys belong to the hostname of the server's address: `CRUMBLE_PUBLIC_URL`, then `BETTER_AUTH_URL`, then `localhost` when the server listens on loopback. Browsers don't offer passkeys at an IP address, or at a plain `http://` address other than `localhost`. Changing the hostname later invalidates every passkey, and accounts sign in with their passwords until they add new ones.

## Environment variables

| Variable                          | Default            | Purpose                                                                                           |
| --------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `CRUMBLE_DATA_DIR`                | `./data`           | Where the server stores accounts and all account data.                                            |
| `CRUMBLE_HOST`                    | `127.0.0.1`        | Listen address. Keep it on loopback unless the server is behind HTTPS.                            |
| `CRUMBLE_PORT`                    | `7337`             | Listen port.                                                                                      |
| `CRUMBLE_PUBLIC_URL`              | Unset              | Public `https://` address, used for sign-in and for MCP OAuth client metadata.                    |
| `BETTER_AUTH_URL`                 | The listen address | Browser address for sign-in. `CRUMBLE_PUBLIC_URL` overrides it.                                   |
| `CRUMBLE_SKILLS_DIR`              | `./skills`         | Directory of default skills.                                                                      |
| `CRUMBLE_WORKSPACE_BACKEND`       | Microsandbox       | Set to `railway` to run workspaces on Railway. See [Set up workspaces](/self-hosting/workspaces). |
| `CRUMBLE_WORKSPACE_IMAGE`         | Unset              | Microsandbox image for workspaces. Enables coding jobs.                                           |
| `CRUMBLE_WORKSPACE_DESKTOP_IMAGE` | Unset              | Microsandbox image with a desktop. Enables bot desktops.                                          |
| `CRUMBLE_RAILWAY_REGION`          | Railway's default  | Region for new Railway workspaces, such as `europe-west4`.                                        |
| `CRUMBLE_CLAUDE_COMMAND`          | `claude`           | Path to the Claude Code executable, if it isn't on `PATH`.                                        |
| `CRUMBLE_CLAUDE_TELEMETRY`        | Enabled            | Set to `0`, `false`, `no`, or `off` to turn off Claude Code telemetry.                            |
| `NODE_ENV`                        | Unset              | Set to `production` to minify the web app.                                                        |
