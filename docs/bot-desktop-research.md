# Bot desktop research: Lightpanda, Camoufox, and cua-driver alternatives

Researched 2026-10-29 against READMEs, docs, source, release pages, and license metadata of each project. Repository activity dates come from the GitHub API on that day. Nothing was installed or run in the workspace for this note; the cua-driver CDP binding behavior described under "Context" was verified earlier in the VM, not here. Claims without a primary source are marked UNKNOWN.

## Summary and recommendation

**Keep Debian Chromium (headful, persistent profile) and cua-driver as the only driver.** No candidate replaces either while meeting the hard requirement: a visible browser on the X display that the owner watches and can take control of.

1. **Lightpanda: do not use it for the bot desktop.** It has no graphical rendering engine and no headed mode ([what is Lightpanda](https://lightpanda.io/docs/core-concepts/what-is-lightpanda), [agent-browser engine page](https://agent-browser.dev/engines/lightpanda)). It could serve a separate headless fetch path for JS-heavy public pages, but it has no profile persistence, reports bot challenges as errors ([1.0.0 release notes](https://github.com/lightpanda-io/browser/releases/tag/1.0.0)), and is AGPL-3.0. Add it only if the existing web search provider's page reading proves insufficient for JS-rendered pages.
2. **Camoufox: avoid.** cua-driver's typed browser tools are CDP-only and refuse Firefox ([support boundaries](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)), so `fill_login` as designed cannot work with it. It is driven only by Playwright over Juggler, so Crumble would need a Playwright process inside the workspace holding the browser. Its default identity changes every launch, maintenance paused for about eight months in 2025, and no primary source shows it beats a real, persistent, headful Chromium on sign-ins.
3. **Keep cua-driver; use its CDP route for page content and AT-SPI for everything else.** cua-driver's own guide prefers the typed browser tools over accessibility guesses for Chromium page content and keeps browser chrome, permission prompts, and other apps on the native AT-SPI path ([BROWSER.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)). That is the hybrid Crumble wants, with one binary and one session.
4. **Do not add a second CDP client (Playwright MCP, Chrome DevTools MCP, agent-browser) unless cua-driver's binding fails in practice.** They are good, actively maintained fallbacks, all able to attach to Chromium on `127.0.0.1:9222`, but each duplicates what cua-driver already does. Whether two CDP clients coexist on one Chromium without interfering with cua-driver's tab binding is UNKNOWN.
5. **Do not adopt agent frameworks that own the LLM loop** (browser-use, Skyvern, Stagehand's agent, UI-TARS, ByteBot). Crumble already owns the loop; these would be a second agent. Their login designs are useful references, not dependencies.
6. **`fill_login` changes suggested by this research:**
   - Pass cua-driver arguments over stdin, not argv. `cua-driver call` accepts JSON "as a positional JSON object or through stdin" ([CLI reference](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/reference/cli/serve-and-configure.mdx)). Today `computer-use-driver.ts` writes the arguments to a `/tmp` file and expands them into argv with `"$(cat file)"`, which would put the password on the guest disk and in the process command line.
   - Keep the planned refusal on stale refs. cua-driver invalidates refs on navigation ([BROWSER.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)), and Hermes Agent's vault re-asserts the origin inside the fill itself ([`browser_vault_tool.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/browser_vault_tool.py)).
   - Check the frame, not only the tab. cua-driver can type into refs in out-of-process iframes ([`tools.rs`](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs)). Whether a ref reports its frame's origin is UNKNOWN (BROWSER.md says each ref reports its "frame kind"). Until verified, refuse when the focused ref is not in the main frame.
   - Treat the remote debugging port as a trust boundary. Anything in the workspace that can reach `127.0.0.1:9222` and get past Chromium's consent dialog can read page state, including filled fields. The desktop job model can click that dialog itself, since cua-driver's own `browser_prepare` clicks it.

## Comparison

"Attach" means connecting to an already running headful Chromium that keeps its persistent profile. Activity is the last push to the default branch and the latest release, as reported by the GitHub API on 2026-10-29.

| Option | Kind | Driving model | Linux X11, any app | Attach to running Chromium | License | Activity | Fit for Crumble |
|---|---|---|---|---|---|---|---|
| **cua-driver** (current) | Driver (CLI, MCP) | AT-SPI tree, plus typed CDP refs for Chromium, screenshots as fallback | Yes | Yes, `browser_prepare` with `existing_profile` (verified in VM) | MIT | Pushed 2026-10-29; 0.38.0 published | Keep |
| [Lightpanda](https://github.com/lightpanda-io/browser) | Headless browser | CDP, WebDriver BiDi, MCP | No, no display output | Not applicable, it is the browser | AGPL-3.0 | Pushed 2026-10-29; 1.0.2 (2026-10-23) | Optional headless fetch path only |
| [Camoufox](https://github.com/daijro/camoufox) | Firefox build | Playwright over Juggler | Browser only; headful on a display | No; Playwright must launch it | MPL-2.0 (browser), MIT (packages) | Pushed 2026-10-29; v158.0-beta.40 (2026-10-19) | Avoid |
| [Anthropic computer-use demo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-demo) | Reference loop | Pixels and coordinates via `xdotool` | Yes | Not applicable, input only | MIT | Pushed 2026-10-29 | Pattern only |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | MCP server | Accessibility snapshot refs | Browser only | Yes, `--cdp-endpoint`; `--extension` for Chrome or Edge | Apache-2.0 | Pushed 2026-10-22; v0.0.83 | Fallback CDP layer |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | MCP server | Snapshot `uid`s | Browser only | Yes, `--browser-url`, `--wsEndpoint`, `--autoConnect` | Apache-2.0 | Pushed 2026-10-29; v1.12.0 | Fallback CDP layer |
| [agent-browser](https://github.com/vercel-labs/agent-browser) | CLI, MCP | Snapshot refs (`@e1`) | Browser only | Yes, `--cdp`, `--auto-connect` | Apache-2.0 | Pushed 2026-10-29; v0.41.0 | Reference for login design |
| [browser-use](https://github.com/browser-use/browser-use) | Agent framework | DOM plus optional screenshots | Browser only | Yes, `cdp_url` | MIT | Pushed 2026-10-27; 0.13.14 | Avoid (owns the loop) |
| [Stagehand](https://github.com/browserbase/stagehand) | SDK and agent | Natural language acts over CDP | Browser only | Yes, `localBrowser.connect({ cdpUrl })` | MIT | Pushed 2026-10-29; server v3.7.7 | Avoid (owns the loop) |
| [Skyvern](https://github.com/Skyvern-AI/skyvern) | Agent platform | Vision LLM over Playwright | Browser only | Yes, `BROWSER_TYPE=cdp-connect` | AGPL-3.0 | Pushed 2026-10-29; v1.0.56 | Avoid |
| [ByteBot](https://github.com/bytebot-ai/bytebot) | Desktop agent | Screenshots, nut-js input | Yes (own Ubuntu desktop) | Not applicable | Apache-2.0 | Archived; last push 2025-09-12 | Avoid (archived) |
| [UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop) | Desktop app and VLM | Pixels via UI-TARS model; Agent TARS adds DOM | Yes | UNKNOWN | Apache-2.0 | Pushed 2026-10-09; v0.3.1 | Avoid |
| [OmniParser](https://github.com/microsoft/OmniParser) | Screenshot parser | Detected regions from pixels | Any (image only) | Not applicable | CC-BY-4.0 repo; weights mixed MIT and AGPL | Pushed 2026-07-20 | Avoid |
| [Steel](https://github.com/steel-dev/steel-browser) / [Browserbase](https://docs.browserbase.com/) | Hosted browsers | CDP | No, remote browser | Their own sessions only | Steel Apache-2.0; Browserbase proprietary | Steel pushed 2026-10-29 | Avoid (not the bot desktop) |
| [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) | Model tool | Pixels and coordinates; harness executes | Harness decides | Harness decides | Proprietary API; sample app MIT | Sample pushed 2026-10-19 | Pattern only |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Agent | cua-driver for desktop; CDP browser tools | Yes | Yes | MIT | Pushed 2026-10-29; v0.22.5 | Reference for vault fill |
| [computer-use-linux](https://github.com/agent-sh/computer-use-linux) | MCP server, CLI | AT-SPI tree, screenshots | Yes | No browser binding found | MIT | Pushed 2026-10-29; v0.7.32 | AT-SPI fallback only |

## Lightpanda

- **What it is.** A new browser written in Zig, "Not a Chromium fork. Not a WebKit patch", using V8 for JavaScript and html5ever for parsing ([README](https://github.com/lightpanda-io/browser/blob/main/README.md)). Its pitch is lower memory and faster execution than headless Chrome for crawling ([README benchmarks](https://github.com/lightpanda-io/browser/blob/main/README.md#benchmarks)).
- **How it is driven.** `lightpanda serve` exposes a CDP WebSocket server; `--protocol webdriver` adds WebDriver BiDi ([README](https://github.com/lightpanda-io/browser/blob/main/README.md)). Docs show Puppeteer `connect` and Playwright `chromium.connectOverCDP('ws://127.0.0.1:9222')` ([Playwright usage](https://lightpanda.io/docs/usage/cdp/playwright)). It also ships an MCP server with per-session browsing contexts and an LLM agent mode ([README](https://github.com/lightpanda-io/browser/blob/main/README.md)). The docs list no Playwright caveats; how complete its CDP coverage is for arbitrary Playwright scripts is UNKNOWN. Camoufox-style version ceilings are not documented either.
- **Maturity.** 1.0.0 was released 2026-10-02 and 1.0.2 on 2026-10-23 ([releases](https://github.com/lightpanda-io/browser/releases)). Releases still change defaults: 0.4.0 stopped loading iframes and workers by default ([0.4.0](https://github.com/lightpanda-io/browser/releases/tag/0.4.0)), and 1.0.0 turned on CORS enforcement ([1.0.0](https://github.com/lightpanda-io/browser/releases/tag/1.0.0)). Package managers install nightlies ([README](https://github.com/lightpanda-io/browser/blob/main/README.md#install)).
- **Compatibility.** The README lists DOM APIs, XHR, Fetch, cookies, proxy support, network interception, and CDP plus BiDi, and points to Web Platform Tests results at [perf.lightpanda.io/wpt](https://perf.lightpanda.io/wpt) ([README status](https://github.com/lightpanda-io/browser/blob/main/README.md#status)). 1.0.0 notes "Generate an appropriate error on a bot challenge" ([1.0.0](https://github.com/lightpanda-io/browser/releases/tag/1.0.0)). Its User-Agent identifies Lightpanda and `--user-agent` rejects values containing "Mozilla" ([common options](https://lightpanda.io/docs/reference/cli/common-options)). Sign-in success on real sites is therefore UNKNOWN and unlikely. Google states it may block sign-in from browsers "controlled through software automation" ([Google Account Help](https://support.google.com/accounts/answer/7675428)).
- **Pixels and visibility.** "Lightpanda drops the graphical rendering engine entirely" ([what is Lightpanda](https://lightpanda.io/docs/core-concepts/what-is-lightpanda)). `Page.captureScreenshot` exists for PNG only ([`page.zig`](https://github.com/lightpanda-io/browser/blob/main/src/server/cdp/domains/page.zig)), and the README calls `--dump png` "a text-only rendering of the page" ([README](https://github.com/lightpanda-io/browser/blob/main/README.md)). agent-browser marks `--headed` "Not applicable (headless only)" for Lightpanda ([agent-browser](https://agent-browser.dev/engines/lightpanda)). There is no window on the X display for the owner to watch or take control of.
- **Accessibility tree.** CDP `Accessibility.getFullAXTree`, `getPartialAXTree`, `queryAXTree` and related methods are implemented ([`accessibility.zig`](https://github.com/lightpanda-io/browser/blob/main/src/server/cdp/domains/accessibility.zig)), plus a `semantic_tree` dump and MCP tool ([AX tree guide](https://lightpanda.io/docs/guides/markdown-axtree)). It does not expose AT-SPI, so cua-driver's native path cannot see it.
- **Cookies and profiles.** `--cookie` loads a cookie file read-only, and `--cookie-jar` saves cookies to JSON on exit. No profile persistence flag is listed ([common options](https://lightpanda.io/docs/reference/cli/common-options)). agent-browser marks `--profile` "Not supported" for Lightpanda ([agent-browser](https://agent-browser.dev/engines/lightpanda)). Persistence of localStorage or IndexedDB across runs is UNKNOWN.
- **License.** AGPL-3.0 ([LICENSE](https://github.com/lightpanda-io/browser/blob/main/LICENSE)). Running an unmodified binary as a tool is different from modifying and serving it, but any patching would carry AGPL obligations.
- **Verdict.** It cannot replace or sit beside Chromium on the bot desktop: no pixels, no window, no profile, and no AT-SPI. As a separate headless "fetch" path it is plausible: Hermes Agent ships it as a local browser engine ([`browser_lightpanda.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/browser_lightpanda.py)), and agent-browser offers `--engine lightpanda` ([README](https://github.com/vercel-labs/agent-browser/blob/main/README.md)). Use it only for logged-out, public, JS-rendered pages, and only if the current web search provider's page reading falls short.

## Camoufox

- **What it is.** "A Firefox build for web scraping and AI agents. Every launch gets a fresh, internally consistent device identity", spoofed in C++ rather than JavaScript ([README](https://github.com/daijro/camoufox/blob/main/README.md)). It also says: "Camoufox can still be detected", and "Some WAFs test SpiderMonkey engine behaviour, which no amount of spoofing turns into Chromium" ([README](https://github.com/daijro/camoufox/blob/main/README.md)). The README banner says it "may not be suitable for stable production use" ([README](https://github.com/daijro/camoufox/blob/main/README.md)).
- **How it is driven.** Python (`pip install camoufox`) or TypeScript launchers return a Playwright `Browser`; Playwright talks to Juggler, which runs in an isolated world the page cannot see ([README](https://github.com/daijro/camoufox/blob/main/README.md)). The supported Playwright range is bounded: issue [#873](https://github.com/daijro/camoufox/issues/873) (open) says 1.63.0 passes and 1.64.0 needs a fix. Recent commits add WebDriver BiDi window handling ([commits](https://github.com/daijro/camoufox/commits/main)).
- **Headful on X11.** `headless=False` is the default and "Needs a display". `headless="virtual"` runs a headed browser on a private Xvfb ([Python README](https://github.com/daijro/camoufox/blob/main/python/README.md#headless-modes)). Pointing it at the bot desktop's Xvnc display is plausible; it was not tested.
- **AT-SPI.** Firefox exposes accessibility on Linux through ATK objects ([Firefox accessibility architecture](https://firefox-source-docs.mozilla.org/accessible/Architecture.html)). Whether Camoufox's patches keep that intact is UNKNOWN.
- **Persistent profiles.** `persistent_context=True, user_data_dir=...` is supported ([Python README](https://github.com/daijro/camoufox/blob/main/python/README.md#persistent-profile)), but "A persistent context cannot be served" over `launch_server` ([Python README](https://github.com/daijro/camoufox/blob/main/python/README.md)). So the process holding the persistent browser must be the Playwright client. A commit from 2026-10-25 fixes saved identities that redrew fonts and GPU across browser upgrades, noting "a site holding the identity's cookies saw a different machine behind the same profile" ([commit 8907d3e](https://github.com/daijro/camoufox/commit/8907d3ef007476cac3a445a81e0d206a4acd48de)). Changing fingerprints under one set of cookies is a sign-in risk, not a benefit.
- **Maintenance.** Commits dropped from 19 in March 2025 to at most 3 per month from April to November 2025 (counting days 1 to 28 of each month), then resumed in December 2025 (GitHub commits API). The maintainer wrote in June 2025: "In March 2025, I had a medical emergency and have been hospitalized since. As a result, I haven't been able to maintain Camoufox" ([profile README at 4cdad0c](https://github.com/daijro/daijro/blob/4cdad0c5e9596108e63eb26a81a3aed5bc4ae80d/README.md)). In January 2026: "I've decided to step down as primary maintainer of Camoufox", handing it to Clover Labs ([profile README at f0201aa](https://github.com/daijro/daijro/blob/f0201aa6b2058b918e1763e7a1417c74213a3e9d/README.md)). Activity is high again (latest release v158.0-beta.40 on 2026-10-19, [releases](https://github.com/daijro/camoufox/releases)), but most recent releases are marked prerelease.
- **License.** Browser MPL-2.0; Python and TypeScript packages MIT; vendored Cursory cursor trajectories LGPLv3-or-later ([README licensing](https://github.com/daijro/camoufox/blob/main/README.md)).
- **Does it help with sign-ins?** No primary source measures Camoufox against a normal headful Chromium with a real, persistent profile on sign-in pages. Its own claims are about fingerprint consistency for scraping. Crumble's Chromium is already headful, on a real display, launched by a script rather than an automation launcher, and reuses one profile, so headless tells do not apply. cua-driver does attach over CDP, which Camoufox's comparison table counts as a detectable signal for Chromium. Sign-in benefit: UNKNOWN, with no evidence for it.
- **cua-driver compatibility.** None for typed browser tools. cua-driver's browser engine is "CDP-native", Firefox and Safari return `browser_route_unavailable`, and "Existing-profile attachment to an already-running ordinary Firefox profile remains a structured refusal" ([engine support plan](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/browser-engine-support-plan.md)). The support table lists "Safari / Firefox: Native window state only" ([BROWSER.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)). Firefox's Remote Agent only starts with `--remote-debugging-port` at launch ([Mozilla Remote Agent security](https://firefox-source-docs.mozilla.org/remote/Security.html)).
- **Verdict.** Avoid. `fill_login` would lose the exact-tab URL check and typed input, leaving AT-SPI typing into whatever has focus, or a separate Playwright process in the workspace.

## cua-driver and the rest of trycua/cua

- **Driver.** cua-driver drives native apps and browsers on macOS, Windows, and Linux through CLI, MCP, or SDKs ([README](https://github.com/trycua/cua/blob/main/README.md#cua-driver)). For Chromium on Linux X11 the typed route supports "Exact binding, refs, navigation, typing, explicit DOM click", and browser chrome, permission prompts, and consent UI stay on the native loop ([BROWSER.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)).
- **Typing.** `browser_type` requires a ref from the latest snapshot ("heuristic bindings are refused"), uses `Input.insertText` or per-key events, and `replace: true` selects existing content first ([`tools.rs`](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs)). Before typing it checks that the ref is the focused, editable element in its own document, including shadow DOM and out-of-process iframes (same file).
- **Refs and frames.** "Navigation and newer snapshots invalidate old refs", and "Each ref reports its frame kind" ([BROWSER.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)). Whether it reports the frame's origin is UNKNOWN.
- **Data handling.** Tab capture "is opt-in because authenticated pages may contain sensitive information" ([BROWSER.md](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/BROWSER.md)). Telemetry "is default-on" and content-free ([CLI reference](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/reference/cli/serve-and-configure.mdx)); Crumble's image already runs `cua-driver telemetry disable`. Computer History is an opt-in, "metadata-only" preview ([history reference](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/reference/cli/skills-recording-and-history.mdx)). Whether trajectory recording, when enabled, stores `browser_type` text is UNKNOWN; keep recording off.
- **Other parts.** Cua Spaces (desktops with "Teleport" of signed-in apps and a multiplayer cursor) and cua-spacesd are FSL-1.1-MIT, not MIT. Lume manages macOS and Linux VMs on Apple Silicon. CUA-S1 is a small forms model in early research release. `cua-agent`, `cua-som`, and `cua-computer` are deprecated, and `cuabot` has "known security issues" ([README](https://github.com/trycua/cua/blob/main/README.md)). The optional `cua-perception` extension bundles an AGPL-3.0 OmniParser model ([README licensing](https://github.com/trycua/cua/blob/main/README.md#licensing)). None of these is needed by Crumble; avoid `cua-perception` for license reasons.

## Anthropic computer-use reference implementation

- Docker image with an X11 desktop over VNC; the `computer` tool shells out to `xdotool` for mouse and keys and takes screenshots ([README](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/README.md), [`computer.py`](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/computer.py)). Pixels and coordinates only; any X11 app; no browser binding.
- Its caution: "Avoid giving the model access to sensitive data, such as account login information" ([README](https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/README.md)). It now documents a `computer_toolset_20260801` shape with one tool per action (same README).
- MIT; pushed 2026-10-29. Crumble already covers this pattern with screenshots as a fallback. Nothing to adopt.

## Playwright MCP

- MCP server that "Uses Playwright's accessibility tree, not pixel-based input", with refs in snapshots; `--caps vision` adds coordinate actions ([README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)).
- Attach: `--cdp-endpoint` connects to a CDP endpoint; `--extension` connects to a running browser "(Edge/Chrome only)" with the Playwright extension installed ([README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)). Whether the extension works on Debian Chromium is UNKNOWN.
- Secrets: `--secrets` replaces matching text in tool responses, but "It is a convenience and not a security feature"; `--allowed-origins` "*does not* serve as a security boundary" ([README](https://github.com/microsoft/playwright-mcp/blob/main/README.md)).
- Browser only. Apache-2.0; v0.0.83 (2026-09-28). The README now steers coding agents to Playwright CLI for token efficiency.

## Chrome DevTools MCP

- MCP server with snapshot `uid`s for `click`, `fill`, `fill_form`, `type_text`, plus performance and network tooling ([tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)).
- Attach: `--browser-url=http://127.0.0.1:9222`, `--wsEndpoint`, or `--autoConnect` to a user-started Chrome ([advanced usage](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md), [configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)).
- Limits: "officially supports Google Chrome and Chrome for Testing only", other Chromium builds "may work"; Google usage statistics are "enabled by default" (opt out with `--no-usage-statistics`); performance tools may send trace URLs to CrUX ([README](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/README.md)).
- Browser only. Apache-2.0; v1.12.0 (2026-10-22).

## browser-use

- Python (and TypeScript) agent library plus a paid cloud with "stealth, CAPTCHA solving and residential proxies" ([README](https://github.com/browser-use/browser-use/blob/main/README.md)). It runs its own LLM loop.
- Attach: `Browser(cdp_url=...)` ([remote browser docs](https://docs.browser-use.com/open-source/customize/browser/remote.md)).
- Secrets: `sensitive_data` placeholders, optionally scoped by URL pattern; "Real values are injected directly into form fields after the LLM call"; set `use_vision=False` "to prevent screenshot leaks" ([sensitive data docs](https://docs.browser-use.com/open-source/examples/templates/sensitive-data.md)).
- MIT; 0.13.14 (2026-10-26). Avoid: a second agent loop.

## Stagehand (Browserbase)

- SDK with `act`, `extract`, `observe`, and an agent; local or Browserbase browsers ([README](https://github.com/browserbase/stagehand/blob/main/README.md)).
- Attach: "`localBrowser.connect()` attaches to a running Chromium browser through its DevTools endpoint" with `cdpUrl`; "Stagehand never closes a browser it did not launch" ([browser config](https://docs.stagehand.dev/v4/configuration/browser.md)).
- Secrets: "Variables are not shared with LLM providers", except that default-on server-side caching sends variable values to Stagehand's cache service ([act docs](https://docs.stagehand.dev/v4/basics/act.md)). The README's login example uses `observe` for selectors and fills credentials directly.
- MIT. Avoid as a dependency; its caching caveat is a warning for any "LLM picks the field, code fills it" design.

## agent-browser (Vercel Labs)

- Rust CLI and MCP server with snapshot refs (`@e1`), engines `chrome`, `lightpanda`, and experimental `obscura` ([README](https://github.com/vercel-labs/agent-browser/blob/main/README.md)).
- Attach: `--cdp <port>` or `--auto-connect`; `--pin-tab` binds a session to a CDP target id across daemon restarts. Its warning: "`--remote-debugging-port` exposes full browser control on localhost. Any local process can connect" ([README](https://github.com/vercel-labs/agent-browser/blob/main/README.md)).
- Login design worth copying: `auth login` checks the active page against the credential URL's "scheme, host, and effective port", fails if the field is replaced or focus moves before entry, and resolves provider credentials in the daemon so they "remain out of process arguments and normal output" ([README](https://github.com/vercel-labs/agent-browser/blob/main/README.md)). It also warns that `type` echoes typed text in batch output.
- Browser only. Apache-2.0; v0.41.0 (2026-10-29).

## Skyvern

- Workflow automation that "relies on Vision LLMs" on top of Playwright, with a cloud offering anti-bot measures and CAPTCHA solvers ([README](https://github.com/Skyvern-AI/skyvern/blob/main/README.md)).
- Attach: `BROWSER_TYPE=cdp-connect` to your Chrome; `page.agent.login` with Skyvern, Bitwarden, or 1Password credentials (same README).
- AGPL-3.0; v1.0.56. Avoid: its own agent loop and server.

## ByteBot

- Self-hosted desktop agent on an Ubuntu desktop with "Live Desktop View" and "Takeover Mode", and password manager support ([README](https://github.com/bytebot-ai/bytebot/blob/main/README.md)). Input via `@nut-tree-fork/nut-js` ([package.json](https://github.com/bytebot-ai/bytebot/blob/main/packages/bytebotd/package.json)).
- The repository is archived (GitHub API; last push 2025-09-12). Apache-2.0. Closest in product shape to Crumble's bot desktop, but dead.

## UI-TARS and UI-TARS-desktop

- UI-TARS Desktop is "a native GUI agent for your local computer, driven by UI-TARS and Seed-1.5-VL/1.6 series models", screenshot and visual recognition based; Agent TARS adds a hybrid browser agent using GUI, DOM, or both ([README](https://github.com/bytedance/UI-TARS-desktop/blob/main/README.md)).
- Apache-2.0; v0.3.1 (2026-10-08). The model repo [bytedance/UI-TARS](https://github.com/bytedance/UI-TARS) was last pushed 2026-01-27. Attaching to an existing Chromium: UNKNOWN. Avoid: a different model family and its own loop.

## OmniParser

- Parses screenshots into interactable regions for vision-only agents ([README](https://github.com/microsoft/OmniParser/blob/master/README.md)). Pixels only; no input layer.
- Repository license CC-BY-4.0 ([LICENSE](https://github.com/microsoft/OmniParser/blob/master/LICENSE)); "Earlier Ultralytics-based icon detectors retain their original AGPL license" (README). Last push 2026-07-20. Avoid: AT-SPI and CDP refs already give Crumble structure without a vision model.

## Steel and Browserbase (hosted)

- Steel Browser is a self-hostable browser API over Puppeteer and CDP with sessions, extensions, and stealth plugins ([README](https://github.com/steel-dev/steel-browser/blob/main/README.md)). Self-hosted Steel has no CAPTCHA solving or Credentials API, and "Limited" stealth ([local vs cloud](https://docs.steel.dev/overview/self-hosting/steel-local-vs-steel-cloud)). Apache-2.0.
- Browserbase offers live view sessions, persistent Contexts, and CAPTCHA solving "enabled by default for all sessions" ([docs index](https://docs.browserbase.com/llms.txt), [CAPTCHA solving](https://docs.browserbase.com/platform/identity/captcha-solving.md)).
- Avoid: the browser would leave the bot desktop, splitting what the owner watches, and logins would live with a third party.

## OpenAI computer use

- The `computer` tool returns actions (`click`, `type`, `screenshot`, and others) that "Your action handler translates ... into browser or operating system input"; OpenAI recommends an isolated browser or VM and "a fresh browser profile or isolated desktop" ([guide](https://developers.openai.com/api/docs/guides/tools-computer-use)).
- On credentials: "Typing sensitive information into a form counts as transmission"; keep credentials out of page text and screenshots (same guide). The sample app drives Playwright or PyAutoGUI ([sample app](https://github.com/openai/openai-cua-sample-app/blob/main/README.md), MIT).
- Pattern only; it is a model capability, not a driver.

## Hermes Agent (NousResearch)

- `computer_use` drives cua-driver and is "Default when computer_use.backend is unset" ([plugin.yaml](https://github.com/NousResearch/hermes-agent/blob/main/plugins/computer_use/cua/plugin.yaml), [skill](https://github.com/NousResearch/hermes-agent/blob/main/skills/autonomous-ai-agents/computer-use/SKILL.md)). Crumble's tool came from here.
- Separately, Hermes has CDP browser tools, a Lightpanda engine, and `browser_vault` ([tools directory](https://github.com/NousResearch/hermes-agent/tree/main/tools)). The vault's `fill` requires the page origin to "EXACTLY match the item's bound origin (pre-checked AND re-asserted synchronously inside the fill script)", injects only over the CDP WebSocket "(never argv)", returns only `{filled_fields, kind, origin, success}`, and registers the secret bytes with a redaction boundary so later browser tool calls cannot echo them ([`browser_vault_tool.py`](https://github.com/NousResearch/hermes-agent/blob/main/tools/browser_vault_tool.py)). This is the closest prior art to Crumble's `fill_login`.
- MIT; v0.22.5 (2026-10-23).

## computer-use-linux

- MCP server and CLI for "semantic AT-SPI trees, screenshots, window targeting, and input across GNOME, KDE, Hyprland, niri, COSMIC, i3, and X11" ([repository](https://github.com/agent-sh/computer-use-linux)), listed in the Hermes README. MIT; v0.7.32 (2026-10-29). No browser CDP binding was found in its description. A fallback only if cua-driver's Linux AT-SPI path regresses.

## Excluded

ScreenAgent (last push 2024-11-25) and OS-Copilot (last push 2024-09-09) are inactive (GitHub API): [ScreenAgent](https://github.com/niuzaisheng/ScreenAgent), [OS-Copilot](https://github.com/OS-Copilot/OS-Copilot).

## Effect on the `fill_login` design

The plan types a stored value with cua-driver `browser_type` into the exact tab after checking the tab URL's host, and scrubs the value from later output.

| Option | Exact-tab host check | Value kept out of model and transcript |
|---|---|---|
| cua-driver CDP binding (current plan) | Yes: tab URL from `get_browser_state`; refs go stale on navigation | Yes, if Crumble passes args over stdin and scrubs later output. Frame origin: UNKNOWN |
| cua-driver AT-SPI only | No: the tree has no page URL, and the address bar shows typed text (plan decision) | Possible, but types into whatever has focus |
| Camoufox | No CDP route in cua-driver; would need a Playwright process in the workspace | Possible via Playwright `fill`, outside cua-driver |
| Lightpanda | Not applicable: no visible desktop, no persistent profile | Not applicable |
| Playwright MCP, Chrome DevTools MCP, agent-browser | Yes, via CDP page URL; agent-browser checks scheme, host, port | Playwright MCP `--secrets` is "not a security feature"; agent-browser `auth login` keeps values out of argv and output |
| browser-use, Stagehand | URL-pattern scoped secrets (browser-use) | Placeholders; Stagehand cache sends values unless disabled |
| Pixel tools (Anthropic, OpenAI, UI-TARS, OmniParser) | No URL source | Value would pass through the harness's type action; screenshots may show it |

Concrete points for implementation:

1. **Stdin, not argv or `/tmp`.** Today the call is ``cua-driver call ${tool} "$(cat ${argsFile})"`` after writing the JSON to a guest file (`apps/server/src/bot-desktop/computer-use-driver.ts`). For `fill_login`, pipe the JSON to `cua-driver call browser_type` on stdin, which the CLI supports ([CLI reference](https://github.com/trycua/cua/blob/main/docs/content/docs/cua-driver/reference/cli/serve-and-configure.mdx)). Hermes and agent-browser both state this rule. Whether the workspace shell layer writes commands or stdin anywhere persistent is UNKNOWN and should be checked.
2. **Glossary tension.** A Credential's value "never enters the workspace" (`GLOSSARY.md`). A login filled into Chromium necessarily does: in Chromium's memory, possibly its form autofill storage (the plan's Task 3 turns off password saving), and in cua-driver's process. The Logins glossary entry in the plan already says the value "enters the page in the bot desktop"; keep the two definitions distinct.
3. **CDP port reachability.** After `browser_prepare`, Chromium listens on `127.0.0.1:9222`, and another client triggers Chromium's consent dialog (plan decision). Chrome only honors the port with a non-default user data directory ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)), which Crumble uses. A coding job's shell in the same workspace, or a desktop job clicking "Allow", could connect and read field values. This is the same boundary Playwright MCP and agent-browser warn about.
4. **Frames.** Until cua-driver is shown to report a ref's frame origin, refuse to fill a focused ref outside the main frame, or verify the frame origin some other way. Sign-in forms embedded from another origin would otherwise pass a top-level host check.
5. **Atomicity.** cua-driver offers no combined "assert URL, then type" call. The plan relies on stale-ref refusal after navigation, which BROWSER.md documents. Hermes goes further by re-asserting origin inside the injected fill script. A same-document URL change (history `pushState` to another path on the same host) would not change the host, so it is harmless for a host check.
6. **Scrubbing scope.** Scrub from `get_window_state` markdown, `get_browser_state` outlines, and error messages alike. Chromium's AT-SPI exposure of password field contents is UNKNOWN; username and one-time code fields are plain text and will appear in trees.

## Limits of this research

- Nothing here was executed in the workspace. Camoufox headful on Xvnc, Lightpanda on target sites, and second-CDP-client coexistence with cua-driver were not tested.
- Benchmarks and anti-bot claims come from the projects themselves.
- Activity figures are a snapshot from 2026-10-29.

## Spike: page tools against the accessibility path (2026-10-29)

Run in the local Microsandbox desktop VM (`crumble-workspace-desktop:dev`, cua-driver 0.38.0, Debian Chromium), timed from the server. A guest exec costs about 3 ms, so the times are cua-driver's.

| Task | Path | Calls | Time | Output to the model | Result |
| --- | --- | --- | --- | --- | --- |
| Fill and submit `test/fixtures/desktop-task.html` | `computer_use` today (accessibility) | 11 | 10.7 s | 6,261 chars | Correct |
| Same | One `run_steps` batch (accessibility, targets by role and name) | 1 | 10.1 s | 5,738 chars | Correct |
| Same | Page tools (`browser_navigate`, `get_browser_state` semantic_v2, `browser_type`, `browser_select`, `browser_click`) | 7, plus 2 polls for load | 2.0 s | 12,957 chars | Correct |
| Wikipedia: search "Ada Lovelace", read the birth date | `computer_use` today | 10 | 10.9 s | 26,151 chars | Article reached; the 12,000-character cut hid the date |
| Same | One `run_steps` batch | 1 | 10.3 s | 7,339 chars | Correct |
| Same | Page tools | did not finish: the script's ref match missed the Search button | | | |

Per call:
- Accessibility actions through `computer_use`: 0.7 to 2 s each (`type` about 1.2 s, `set_value` 2 s). Each acts, waits, and checks.
- Page tools: `get_browser_state` reads 10 to 650 ms, `browser_navigate` 20 to 500 ms, `browser_select` 17 ms, `browser_type` and foreground `browser_click` about 600 ms.
- Reading a whole Wikipedia article with `semantic_v2` returned 88,585 characters; reads need `query` or `scope_ref`. A narrowed accessibility read (`get_window_state` with `query`) returned 938 characters in 1.6 s. `computer_use` doesn't pass `query` through today.

Behavior found:
- `browser_prepare` takes about 7.7 s and attaches only the cua-driver session that ran it: a second session's bind is refused with `browser_consent_required` and must prepare again. So preparing at desktop start doesn't help a job whose session is new; preparing once per job session does.
- `browser_navigate` returns before the page loads; the next read can show the old title. A read must wait for the new page.
- `browser_click` in the default background mode needs `delivery_mode: "foreground"` on Linux Chromium (its description says background trusted input is refused there). Foreground clicks worked.
- `browser_select` takes exactly one of `label` or `value`.
- `get_window_state` called directly returns a screenshot unless `include_screenshot: false`.
