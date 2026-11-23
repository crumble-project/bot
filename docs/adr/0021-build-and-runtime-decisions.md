# Build and runtime decisions

- Status: Accepted

## Data directory exclusivity

The server stores `server.pid` inside `CRUMBLE_DATA_DIR`. It refuses a different live PID only when the recorded hostname matches (`apps/server/src/app/data-lock.ts`). The container volume contains both the data and this record.

This is not a distributed or cross-hostname lock. The removed Docker comment incorrectly placed the record beside the data directory and promised exclusion between all containers sharing a volume. Those claims were stale; this cleanup does not strengthen the implementation.

## Tailwind compatibility fallback

`apps/web/shadcn-tailwind.css` keeps a reduced-motion `.shimmer` rule outside Tailwind's utility layer. The unlayered rule preserves its cascade precedence for existing plain `.shimmer` consumers; the utility handles variants for current callers.

## Workspace desktop process model

The desktop image omits `xfce4-session`, which would restore sessions and run autostart entries. `desktop-start.sh` launches the required XFCE processes directly, outside pi-env's child-process lifetime. Chromium uses `--no-sandbox` because the guest runs as root and the VM supplies isolation. Unused GVFS, power, and screensaver daemons are omitted; `xfdesktop` supplies the wallpaper.

Clear Chromium singleton locks before launch because a checkpoint restored on another machine can retain the previous host's lock. Keep Chromium running independently of the panel, disable crash-restore prompts, and use the basic password store because there is no keyring to unlock. Keep launch flags aligned across launchers. Managed browser policy disables saving logins into workspace profiles.

Chromium trusts the guest credential authority through its NSS database. Apply desktop configuration at boot on both backends, and enable accessibility before starting Chromium because it reads that switch only at startup. The host can wait for the display listener separately from browser readiness. Application launchers start in `/workspace`; the panel's migration setting suppresses its first-run dialog.

Maximize each new app window once, preserving dialogs and any subsequent owner or job restoration. Observe window events after the window manager is ready; use line-buffered events and retry placement requests briefly. X11 reuses closed window IDs, so remove closed windows from the seen set. Thunar's root-account warning is hidden because these desktops intentionally run as root inside their own machines.

## Build and CI boundaries

Use a glibc guest image for cua-driver. Install the upstream Node binary because package executable shebangs still invoke Node in Bun projects. The GitHub CLI reads the bot's `GH_TOKEN`; use its upstream package instead of a lagging distro build. Git template hooks preserve owner attribution for bot commits. Install SVG icon support for Thunar's Adwaita icons.

Keep the CI check name stable for branch-protection consumers. Install the standalone docs and site dependencies before type-aware lint, and generate the site's route tree before lint. The old reference to a separate API-contract workflow is obsolete.

Blume's CLI runs with Bun explicitly; deployment uses Wrangler's Node execution path. Queue deployments so an older commit cannot finish after a newer deployment. Use the worker configuration produced by the Cloudflare build plugin. Pull-request image checks use one platform to limit build time.

React Doctor needs full Git history to compare against the merge base instead of treating pre-existing findings as regressions. The original workflow intent distinguishes pull-request regressions from main-branch health tracking; action behavior remains controlled by the pinned action and its configuration.

Commit messages and pull-request titles share one Conventional Commit validator because squash merges use the title as the final subject. Pass PR text through environment variables instead of interpolating it into shell code. Exempt Git-generated merge/revert and autosquash subjects where the hook explicitly recognizes them. Push checks compare against the current main tip.

## Presentation and configuration

Use page-level overscroll control for the installed web app. Some transcript and menu scroll regions cannot use the ScrollArea component, so their CSS remains explicit. Application code stays strict while third-party declaration checking is skipped through `skipLibCheck`.

Keep remote-push key files outside the repository. Shell shebangs remain executable interpreter metadata. Neither Dockerfile needs an explicit frontend syntax directive for its current instructions.
