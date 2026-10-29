---
title: Configuration
description: Environment variables for the Crumble server, and what to set before exposing it to a network.
sidebar:
  order: 1
---

Configure the server with environment variables.
When you run `bun run dev`, coding and desktop images default to their published
`:main` versions. Other startup commands leave both images unset.

## Expose the server

The server listens on `127.0.0.1` and has open registration, so anyone who can reach it can create an account. To use it from other devices:

1. Put the server behind a reverse proxy that serves HTTPS.
2. Set `CRUMBLE_PUBLIC_URL` to the public `https://` address. Sign-in fails through a proxy or another hostname without it.

## Passkeys

Passkeys belong to the hostname of the server's address: `CRUMBLE_PUBLIC_URL`, then `BETTER_AUTH_URL`, then `localhost` when the server listens on loopback. Browsers don't offer passkeys at an IP address, or at a plain `http://` address other than `localhost`. Changing the hostname later invalidates every passkey, and accounts sign in with their passwords until they add new ones.

## Encryption key

Each account encrypts its credentials with its own key. Without `CRUMBLE_MASTER_KEY`, that key is stored in `.secret.key` in the account's data directory, next to the database it protects, and the server says so at startup. Anyone who can read the data directory, or a backup of it, can decrypt the credentials.

Set `CRUMBLE_MASTER_KEY` to keep a usable key out of the data directory:

1. Generate a key and store it where you keep the server's other secrets:

   ```bash
   openssl rand -base64 32
   ```

2. Set `CRUMBLE_MASTER_KEY` to it and restart the server.

On start, each account's key is wrapped with the master key and stored in `.secret.key.wrapped`, and the plain `.secret.key` is deleted. New accounts only get the wrapped file.

The server then refuses to start an account if `CRUMBLE_MASTER_KEY` is missing or different. It never replaces a key that has encrypted data. If you lose the master key, the account's credentials can't be recovered.

To stop using a master key, stop the server, then unwrap each account's key in its directory, `CRUMBLE_DATA_DIR/users/USER_ID`, with the master key still in the environment. The wrapped file is deleted only after the plain key is unwrapped and saved to disk; if unwrapping fails, both files stay as they were.

```bash
bun -e 'const c = require("node:crypto"), f = require("node:fs");
const [iv, tag, data] = f.readFileSync(".secret.key.wrapped", "utf8").trim().split(":").map((p) => Buffer.from(p, "base64"));
const d = c.createDecipheriv("aes-256-gcm", Buffer.from(process.env.CRUMBLE_MASTER_KEY ?? "", "base64"), iv);
d.setAuthTag(tag);
const key = Buffer.concat([d.update(data), d.final()]);
if (key.length !== 32) throw new Error("not an account key");
const fd = f.openSync(".secret.key", "wx", 0o600);
f.writeSync(fd, key);
f.fsyncSync(fd);
f.closeSync(fd);' && sync && rm .secret.key.wrapped
```

Then unset `CRUMBLE_MASTER_KEY` and start the server.

## Environment variables

| Variable                          | Default            | Purpose                                                                                                   |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------- |
| `CRUMBLE_DATA_DIR`                | `./data`           | Where the server stores accounts and all account data.                                                    |
| `CRUMBLE_HOST`                    | `127.0.0.1`        | Listen address. Keep it on loopback unless the server is behind HTTPS.                                    |
| `CRUMBLE_PORT`                    | `7337`             | Listen port.                                                                                              |
| `CRUMBLE_PUBLIC_URL`              | Unset              | Public `https://` address, used for sign-in and for MCP OAuth client metadata.                            |
| `BETTER_AUTH_URL`                 | The listen address | Browser address for sign-in. `CRUMBLE_PUBLIC_URL` overrides it.                                           |
| `CRUMBLE_MASTER_KEY`              | Unset              | 32 random bytes in base64 that wrap each account's encryption key. See [Encryption key](#encryption-key). |
| `CRUMBLE_SKILLS_DIR`              | `./skills`         | Directory of default skills.                                                                              |
| `CRUMBLE_WORKSPACE_BACKEND`       | Microsandbox       | Set to `railway` to run workspaces on Railway. See [Set up workspaces](/self-hosting/workspaces).         |
| `CRUMBLE_WORKSPACE_IMAGE`         | Unset              | Microsandbox image for workspaces. Enables coding jobs.                                                   |
| `CRUMBLE_WORKSPACE_DESKTOP_IMAGE` | Unset              | Microsandbox image with a desktop. Enables bot desktops.                                                  |
| `CRUMBLE_RAILWAY_REGION`          | Railway's default  | Region for new Railway workspaces, such as `europe-west4`.                                                |
| `CRUMBLE_CLAUDE_COMMAND`          | `claude`           | Path to the Claude Code executable, if it isn't on `PATH`.                                                |
| `CRUMBLE_CLAUDE_TELEMETRY`        | Enabled            | Set to `0`, `false`, `no`, or `off` to turn off Claude Code telemetry.                                    |
| `NODE_ENV`                        | Unset              | Set to `production` to minify the web app.                                                                |
