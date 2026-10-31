# Workspace tool persistence: discussion

Status: open discussion, nothing decided. Pick up from "Next decision".

## Problem

Programs a bot installs outside `/workspace` are lost whenever its machine is created anew. Example: a bot installed Bun to `/usr/local/bin/bun`, outside the persistent disk. Reinstalling after every rebuild wastes job time, and sandboxes can be killed repeatedly.

When installs are lost today:

- **Microsandbox** (`apps/server/src/workspaces/microsandbox-workspaces.ts`): restarts the bot's existing machine when it can, keeping its root disk. It creates a new machine when the image changes, the network settings version (`TCP_THROUGH_PROXY_VERSION`) changes, the old machine doesn't start, or its proxy port is taken. Only the named volume at `/workspace` (8 GiB, `DISK_MIB`) survives.
- **Railway** (`railway-workspaces.ts`): keeps the disk through checkpoints; on an image change only `/workspace` is copied into the new sandbox.
- Jobs run as root, so `HOME=/root`, also outside `/workspace`.

## Requirements

- A machine created anew gets its tools back fast, without the bot remembering to reinstall.
- **Shared across bots:** if one bot downloaded Rust, another bot doesn't download it again.
- A bot can never change what another bot installs (no cache poisoning).
- Works on Microsandbox (named volumes) and Railway (no volumes, checkpoints).
- Bots keep installing the ordinary way (`apt install`, `curl | sh`).

## Options

| Option | Survives rebuild | Shared across bots | Poisoning risk | Effort | Notes |
|---|---|---|---|---|---|
| Caching proxy for package downloads | No, makes reinstalls fast | Yes, automatically | Low: content comes from upstream; bots only trigger fetches | Medium | Covers apt, rustup, crates, npm/bun, PyPI, GitHub releases, Nix downloads. Needs TLS interception with the guest CA the credential proxy already installs. |
| Home directory on the disk (`/root` linked to `/workspace/.home`, `PATH` extended) | User-level tools (rustup, bun, uv, cargo, pipx, nvm, `npm -g` with prefix) | No | None | Small | Doesn't cover apt. Caches and toolchains share the 8 GiB disk. |
| Setup script run once on a new machine | Yes, if the bot keeps it current | Only through the proxy | None | Small | Fragile: easy to forget; `curl \| sh` installers drift. |
| Per-bot Dockerfile `FROM` the workspace image, built on the host | Yes, it is the machine's image | Yes, identical build steps share cached layers | Low, keyed by step and inputs | Medium-large | Fits the existing model: Microsandbox boots OCI images, Railway builds templates from recipes. Bots write Dockerfiles reliably. Needs BuildKit (or similar) on the host. |
| Nix: per-bot package file plus a shared binary cache | Yes | Yes, read-only downloads from the cache | Low if only the host adds to the cache | Large | Most reproducible, with rollback. Bots write Nix less reliably, nixpkgs lacks some things, the store is large, Nix must be in the image. |
| mise with a `mise.toml` per project | Yes, if its install folder is on the disk | Through the proxy | None | Small-medium | Language toolchains (Rust, Go, Java, Bun); no system packages. |
| Shared read-only toolchain folder on the host | Yes | Yes, no per-bot copies | None, the host fills it | Medium | Fastest, but curated: bots can't add tools themselves. |
| Persistent root layer (whole root disk on the volume) | Only while the base image is unchanged | No | None | Medium | Breaks on image updates; impossible on Railway. |
| Terraform / OpenTofu | n/a | n/a | n/a | n/a | They provision machines and cloud resources, not what is installed inside a machine. Not relevant. |

## Recommendation (draft)

1. **Caching proxy first.** The only option that delivers "Rust downloaded once" for every package manager without bots changing how they work.
   - Cache only fixed artifacts: versioned URLs, `.deb` files, crate files, toolchain archives.
   - Pass through what changes: apt package indexes, `latest` installers.
   - Never cache a request that carries a credential placeholder or an `Authorization` header.
2. **Home directory on the disk.** Small; most language toolchains survive a rebuild without extra steps.
3. **A per-bot declared environment** for system packages. Leaning toward a Dockerfile layered on the workspace image rather than Nix:
   - Machines already boot from images, so a bot's image fits the existing model.
   - Bots write Dockerfiles reliably.
   - Cached build layers give sharing for identical steps.
   - The proxy speeds up both builds and Nix downloads if Nix is chosen later.

   Nix wins if exact reproducibility and rollback matter more than the bot getting it right.

## Unknowns

- Whether Microsandbox can build images itself or only load finished ones. The self-hosting docs load a tar, so a separate builder is likely needed.
- Whether Railway caches template builds across bots.
- What share of guest traffic is fixed, cacheable URLs. Measure from workspace proxy logs before building the cache.

## Next decision

The per-bot declaration format: a Dockerfile on the workspace image, Nix, or mise plus a setup script. The proxy cache and the home directory are needed with any of them.

## Done so far

- `ad25420`: workspace images ship Bun 1.4.4 instead of Node (`debian:trixie-slim` base); Railway installs Bun and keeps its own Node.
