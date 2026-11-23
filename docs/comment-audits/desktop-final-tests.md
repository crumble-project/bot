# Desktop final test comment audit

Locations and hashes refer to the original inventory at `/tmp/crumble-comments-now.json`.

| Original location                                       | SHA-256                                                            | Category            | Action                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/bot-desktop/desktop-jobs.test.ts:50`   | `85d96f2a409d69c3e32ade859cc83b82b52c155272ab2a2fa28127f64622ca3d` | Test setup          | Deleted; states why the test timeout is raised, but adds no information needed to understand the timeout or tests.                 |
| `apps/server/src/bot-desktop/desktop-jobs.test.ts:375`  | `1231ce56e33965f7ecb4b15d345a02cf4c6566d0fd640fe11e7a30132de9d744` | Tautology           | Deleted; the test constructs a narrow fake `Agent` with only the ID consumed by the extension lookup.                              |
| `apps/server/src/bot-desktop/desktop-viewer.test.ts:80` | `9b8bfea455b2684fa5de68b1a2f9c3e7ec05a6f9e4508d509309339d942059ad` | Tautology           | Deleted; the assertion checks the fixed handshake byte and the allowed pointer event directly.                                     |
| `apps/server/src/bot-desktop/desktop-vm.test.ts:109`    | `d70f4846f483b3c05f0317ebcd358504de06f04e791881ff706beac1ee438fa6` | Test fixture timing | Deleted; the assertion retries capture until the submitted page state appears, encoding the asynchronous page-update behavior.     |
| `apps/server/src/bot-desktop/desktop-vm.test.ts:338`    | `2961ecbff8b0875c3e13b9c5694a5623e0e5c0e8206701ea80941175dae82630` | Test fixture timing | Deleted; `eventually` waits for the window's accessibility tree and expected controls.                                             |
| `apps/server/src/bot-desktop/desktop-vm.test.ts:394`    | `f3668eb64f6a552d0b48dc4762dfa0629b34cf56f46b10b90ca0f7b3fb9632ed` | Test fixture timing | Deleted; the test polls for Chromium's profile file before restarting, then verifies restore behavior.                             |
| `apps/server/src/bot-desktop/desktop-vm.test.ts:499`    | `6da328401881b404e2077c0377e3b43c004c7dd5331f37224691828af374756e` | Tautology           | Deleted; the route's path is consumed by the test's viewer request; the narrow response cast is local to this integration fixture. |
| `apps/server/src/bot-desktop/desktop-vm.test.ts:541`    | `ffe098534f1938a7c326b9b6a85a1beb158d1e10f7b931484fcb1eb58fbbac47` | Tautology           | Deleted; the test checks successful sign-up before consuming the token from its response.                                          |
| `apps/server/src/bot-desktop/desktop-vm.test.ts:549`    | `a19b6dc8a4e1c8286231078db222f5f5f1426860d82bfa70e107baf9a69921c6` | Tautology           | Deleted; the created agent ID is consumed by subsequent integration requests; the narrow response cast is local to this fixture.   |

No executable test logic was changed. No unsupported design rationale was added to ADR 0015, and no separate decision or issue draft was needed.
