# Accounts and legacy migration

Better Auth manages email/password accounts, sessions, and sign-out at `/api/auth/*`. Set `CRUMBLE_PUBLIC_URL` to your HTTPS origin behind a proxy. Local development uses the listener origin; `BETTER_AUTH_URL` can override it.

Each account owns its data under `CRUMBLE_DATA_DIR/users/USER_ID`. The root `auth.sqlite` contains account identities and sessions. Back up `.auth-secret` and every user's `.secret.key` with the databases. Shared memories and skills belong to one account, and bundled skills remain read-only server defaults.

Existing native clients need account authentication. Sign in with `POST /api/auth/sign-in/email`, then use its returned token as a bearer token. The former server token is rejected. Browser sessions use HTTP-only cookies; writes require the configured `Origin`.

## Assign legacy data

The server never assigns legacy data to the first person who registers. An operator must select its owner explicitly.

1. Stop the old server and back up its entire data directory and Microsandbox home.
2. Start this version with the same `CRUMBLE_DATA_DIR`.
3. Create the intended owner's account through the authentication endpoint. Do this before opening the UI or requesting `/v1`, which initializes an empty tenant.

   Replace `OWNER_EMAIL`, `OWNER_NAME`, and `OWNER_PASSWORD` with the account details:

   ```bash
   curl --fail-with-body http://127.0.0.1:7337/api/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     --data '{"email":"OWNER_EMAIL","name":"OWNER_NAME","password":"OWNER_PASSWORD"}'
   ```

4. Stop the server.
5. Assign the legacy data to that account:

   ```bash
   CRUMBLE_DATA_DIR=./data bun tools/assign-legacy-owner.ts OWNER_EMAIL
   ```

6. Restart the server and sign in through `/ui`.

The command holds the server's data lock, validates the account, and copies legacy databases, encryption keys, and transcript files through a staging directory. It preserves the originals and records the assignment. It refuses active servers, repeated assignments, and nonempty destination directories. It never copies the old server token or account database.

Legacy Microsandbox volumes use `crumble-BOT_ID`; new volumes use `crumble-USER_ID-BOT_ID`. The migration command preserves the original volumes. Copy their contents into the corresponding new volumes separately if you need existing workspace files.

The host-wide Claude Code provider and host environment API keys are disabled for account runtimes. Configure provider credentials separately in each account's settings.

For Docker, stop the service before running the migration against its volume:

```bash
docker compose stop crumble
docker compose run --rm crumble bun tools/assign-legacy-owner.ts OWNER_EMAIL
docker compose up -d
```
