# Accounts

Better Auth manages email/password accounts, sessions, and sign-out at `/api/auth/*`. Set `CRUMBLE_PUBLIC_URL` to your HTTPS origin behind a proxy. Local development uses the listener origin; `BETTER_AUTH_URL` can override it.

Each account owns its data under `CRUMBLE_DATA_DIR/users/USER_ID`. The root `auth.sqlite` contains account identities and sessions. Back up `.auth-secret` and every user's `.secret.key` with the databases. With `CRUMBLE_MASTER_KEY` set, each user's key is stored wrapped in `.secret.key.wrapped` instead, and the master key is backed up separately. Shared memories and skills belong to one account, and bundled skills remain read-only server defaults.

Claude Code uses `CRUMBLE_DATA_DIR/users/USER_ID/claude` for its account-specific configuration and `CRUMBLE_DATA_DIR/users/USER_ID/claude-work` as its working directory. The server ignores both `CLAUDE_CONFIG_DIR` and the legacy `CRUMBLE_CLAUDE_CONFIG_DIR` environment variable. It can use one shared executable from `PATH` or `CRUMBLE_CLAUDE_COMMAND`, while each account keeps a separate Claude Code login.

Existing native clients need account authentication. Sign in with `POST /api/auth/sign-in/email`, then use its returned token as a bearer token. The former server token is rejected. Browser sessions use HTTP-only cookies; writes require the configured `Origin`.

## Claude Code sign-in

Claude Code sign-in is separate from provider API keys. In **Settings**, select **Providers**, find **Claude Code**, and run the displayed sign-in command on the server. The command sets that account's `CLAUDE_CONFIG_DIR` before it runs `auth login`, for example:

```bash
CLAUDE_CONFIG_DIR="/srv/crumble/data/users/USER_ID/claude" claude auth login
```

Run the displayed logout command to remove that account's Claude Code session. Crumble does not perform either command. Status is cached for up to 30 seconds. Refresh the provider list after signing in or out.
