# Provider login research

## OpenAI verification

Investigated the installed `@earendil-works/pi-ai` 1.3.0 source and executed its actual login functions with a fake HTTP boundary. No real provider endpoints, accounts, browser sessions, or stored credentials were used.

| Provider | Remote path | Verification |
| --- | --- | --- |
| `openai` | Browser authorization followed by pasting the full final callback URL into the `manual_code` prompt | Passed with fake token response and no browser request to the server callback listener |
| `openai-codex` | Select `device_code`, display the verification URL/code, and let the server poll | Passed with fake device authorization, polling, and token endpoints; no callback listener required |
| `openai-codex` | Select `browser` and paste the final callback URL | Passed with fake token response |

A fourth probe verified that cancelling the ChatGPT manual prompt rejects login before token exchange. All four probes passed with `bun /tmp/crumble-openai-login-probe.ts`. The probe is temporary, not a retained regression test.

### Constraints for Crumble

- OpenAI requires a stable installation UUID through `LoginOptions.getDeviceId`. Pass an application name through `agentName` rather than introducing Crumble as Pi.
- The OpenAI ChatGPT flow always opens a listener on server loopback port 1455, even when manual input completes the flow. An occupied port fails explicitly. No Docker port publishing is needed for manual input, but that internal port must be available.
- OpenAI ChatGPT manual input requires the full `http://127.0.0.1:1455/auth/callback` URL, including matching `state` and the issued `client_id`. A bare authorization code is insufficient.
- Codex device flow avoids the callback port entirely. Its provider deadline is 15 minutes; Crumble's approved 10-minute inactivity limit can end an unattended attempt sooner.
- Codex browser login falls back to manual input if it cannot bind the callback port. The callback URL uses `localhost`, unlike the OpenAI ChatGPT flow's `127.0.0.1`.
- Different provider sessions can contend for the same internal callback port. Do not promise that every simultaneous browser login succeeds; surface the conflict and preserve the existing session.
- Pi AI can include response bodies or serialized token response data in thrown errors. Crumble must not expose raw provider exceptions in client statuses or logs. Return sanitized errors without authorization secrets.
- Rejected or aborted `prompt()` calls must settle promptly and honor both session and per-prompt abort signals. The ChatGPT cleanup path depends on its pending prompt rejecting when cancelled.

### Primary sources and limits

- Installed source: `bot/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js`, especially `loginOpenAIChatGPT`, `authorizationResultFromManualInput`, and `requestToken`.
- Installed source: `bot/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js`, especially `openaiCodexOAuth.login`, `loginOpenAICodexDeviceCode`, and `loginOpenAICodex`.
- Installed types: `bot/node_modules/@earendil-works/pi-ai/dist/auth/types.d.ts`, especially `LoginOptions`, `AuthInteraction`, and `CredentialStore`.
- [OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth), fetched through `https://developers.openai.com/codex/auth/`, documents device-code login for headless environments. It says the owner or workspace administrator may need to enable device-code login.

These checks establish usable library paths for implementation, not successful authentication with a real account. Live authorization, account eligibility, provider policy, and end-to-end macOS-to-Docker login remain acceptance checks after implementation.


Investigated installed `@earendil-works/pi-ai` 1.3.0. Non-OpenAI findings are source inspection; OpenAI findings also include offline execution probes. No live login or provider requests were performed. Package files are not committed, so local source links require installed dependencies.

| Provider | Source-verified path and implications |
|---|---|
| Anthropic | [anthropic.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/anthropic.js): browser authorization plus loopback callback on preferred port 53692, fallback ephemeral port, and remote-browser pasted redirect URL; also copy-code flow using `manual_code`. Events include `auth_url` and `progress`. Uses callback helper, abort signal, and PKCE. Tokens carry refresh/access/expiry. |
| GitHub Copilot | [github-copilot.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/github-copilot.js): prompts `text` for optional Enterprise domain, notifies `device_code`, and performs RFC device polling. Remote browser works; no callback port. Device flow proceeds to token exchange, Copilot-token fetch and model catalog fetch (plus best-effort enablement), so cancellation/request failures there can fail login. Stores refresh token, access token, expiry, optional enterprise URL and available model IDs. |
| Radius | [radius.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/radius.js): `select` prompt chooses browser or device code. Browser discovery is gateway `/v1/oauth`; it binds exactly `127.0.0.1:1456/oauth/callback` and offers no manual redirect fallback, so remote browser is blocked unless that callback port can be forwarded/reached. Device-code choice is explicitly for another device, notifies `device_code`, polls abortably, and needs no port. Stores access/refresh/expiry/scope; gateway context is needed for refresh. |
| OpenRouter | [openrouter.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/openrouter.js): PKCE callback uses ephemeral loopback port, races callback against manual input; remote browser can paste final redirect URL/code. No fixed mandatory port. Returns permanent user-controlled key as OAuth credential; refresh is identity. `auth_url`/`progress` notifications; exchange honors cancellation and has 30-second timeout. |
| xAI | [xai.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/xai.js): device-code flow only; notifies `device_code`, accepts HTTPS verification URLs, and polls with the shared helper. Remote browser supported; no callback port or prompt. Stores refresh/access/expiry; refresh token may be omitted on refresh and is retained. |
| Meta | [meta.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/meta.js): device-code flow, notifies `device_code`, then `progress` while minting an API key. Remote browser supported; no callback port or prompt. Identity token is stored in `refresh`, minted API key in `access` (about 24-hour expiry); identity cannot refresh and failed key mint requiring 401/403 means sign-in again. |
| Kimi Coding | [kimi-coding.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/kimi-coding.js): device-code flow; notifies `device_code`, validates both HTTP(S) verification URLs, polls with shared helper. Remote browser supported; no callback port or prompt. Stores refresh/access/expiry; refresh retries transient failures up to three retries, but abort may surface as refresh-aborted. |

Shared [callback-server.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/callback-server.js) uses Node HTTP, validates GET path and optional state, handles callback errors, abort, timeout and close; its manual-input race sends `{ type: "manual_code", message, placeholder, signal }`, then aborts the losing prompt. If the prompt rejects, helper cancels callback; a callback completing first cancels the listener, which can expose cancellation/rejection behavior in host prompt implementations. Device polling in [device-code.js](../node_modules/@earendil-works/pi-ai/dist/auth/oauth/device-code.js) defaults interval to five seconds, enforces 1-second minimum, adds five seconds on `slow_down`, and aborts sleep with `Login cancelled`; a poll implementation that ignores signal can remain in-flight. Source inspection only; no live login or provider requests were performed.
