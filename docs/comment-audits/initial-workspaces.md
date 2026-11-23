# Initial workspace comment audit

The first batch removed 43 comments spanning 67 comment-only lines. It contained 2 Tautology, 2 Stale, 1 Excuse, and 38 Decision Record comments. The continuation completed the rest of the repository; see [the final report](../comment-cleanup.md).

## Per-comment audit

Locations refer to commit `125cefd`, before removal. Each single-line comment token has its own row, including consecutive lines of one explanation. The fingerprint identifies the exact original text without duplicating that text here.

| Original location | SHA-256 | Category | Action |
| --- | --- | --- | --- |
| `apps/server/src/workspaces/machine-workspaces.ts:56` | `5c7c42d3bf5e631fb676abd0d9a72cdc43ea98afb9055c66abc055b73ac3c28f` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:62` | `9b4a9b023fd73eb2648581313a29639abf5ef195c7ade0084dc44ad1a222bf66` | Stale | Deleted; Railway sync uses a timer, not an awaited checkpoint (`railway-workspaces.ts`, `get sync()`) |
| `apps/server/src/workspaces/machine-workspaces.ts:64` | `9298cdbf2b9161bdf71453239d2e1afbf1db2c1e44b49e456bfb5d67d1d38bf0` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:76` | `1281ec6ac95b51492ca0676b7e04264183b458062d366ab8a48a7d085a757d51` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:95` | `cb3c18375402dc327023e723a181f19c67fd3f236a1b147a12cce4a260bd71e9` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:97` | `127f1b9e47d2b0defe53aee4c9549d6dfdfc65581b24cf85d7629d7c3764dd3e` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:107` | `1b1b4d13bf41743fa1c114932d6183065ca7534527c78a133ffe41ebd05cb822` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:115` | `85fe54b6a66a700d7d3174098a4d8574894d4c25953eea019f0d7786ff0f4720` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:129` | `49e0cc393fed5200bee09b71875fb4c8d98ae6dc5ed6ab4f7a3bf8d64a3593be` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:133` | `711402b6701466457979c4102e1ca9ca78dd90e1c7e52389b83a155f88a84545` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:158` | `8f5023ad1d6a908d1c94a285acbb8e05a57c51f9230ddca3359d00ea73afe767` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:171` | `cbbec0c1cc03e14accdb8dc20f5f47eddf1f6884fffd00d4d24ac8cf4e36915d` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:253` | `06979df307968b5588f4b74d8ce8d2ed961cfa3220e3f3a88bfc20ac1dadc23f` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:301` | `b438179fd801063491ca1a1698a761f83bfb3c430fa0864dcfa0d97be936389b` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:313` | `d68b2a3247e9889dd54a9ab48336a96cfaecb84f0bc9fc7deee508667af14f4c` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:350` | `80adf0122031f9cda6dc90719b410942d902824e0b933386fa504172e4b09335` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:384` | `55982db20332ce76b639af3c684f88ed4e1245fef410a4906c301004c12768d9` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:391` | `7e75baa82f02faa3a68ff12ac321d966b1b5f6be92041964bd8bbea6d315a4a2` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:448` | `23ba77a5ed1710f09e290678b27d7926a2890333efc5f921c88eb551e8d4737b` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:506` | `9cffa6b12f1f8a8c2cc42ecc399a528e65e52ee2026f7df12a461c162236b11a` | Tautology | Deleted; the image guard and DesktopNotEnabled error state this directly |
| `apps/server/src/workspaces/machine-workspaces.ts:519` | `3be3962de33850722c5aed2ce48702c21ae51667ad2e81765ea64592d72f07d1` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:762` | `0e2ff5131221b9613116efca8e7e223ad9f95f062560c1d5f97f3e98f025542b` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:797` | `5ec377af2f9ead707e4ec49d2f44b2c57e1aecc9836ebf1f03bfd1043fbd39b0` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:806` | `b7021752c01322b1f08f19aa47de658afac1a9cc87c56e1fb5672cbd4c8c38dd` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/machine-workspaces.ts:844` | `3be3962de33850722c5aed2ce48702c21ae51667ad2e81765ea64592d72f07d1` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/railway/workspace-tunnel.ts:5` | `11464e2a2575ace8d48a4e06f5175c060a7443fb9c1f2952d5fd122f8f61ad02` | Tautology | Deleted; the path names the guest program |
| `apps/server/src/workspaces/railway/workspace-tunnel.ts:52` | `d4aa0ba60518b60f8bd7ad955fed3a4d21581f6cc6b00809af3c263d97756539` | Decision Record | Moved to ADR 0011 |
| `apps/server/src/workspaces/railway/workspace-tunnel.ts:109` | `4b9bbd611e41debb45cd6bc97da0478bd414cb924a6da6386a7a3d3b4fe6209c` | Excuse | Deleted; filed [issue #155](https://github.com/crumble-project/bot/issues/155) |
| `apps/server/src/workspaces/workspace-bridge.ts:4` | `367bcfe575e90ef0fdd325d00015c637cb9ec6b3c13c88a80e009556f9aa64a2` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace-bridge.ts:5` | `b55c29baa875a15f1cb4f0c6b35e16d32e1e770fff16d2fba3dd418d7ac04492` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace-bridge.ts:6` | `5cc54fdc0a222b92eaef5aa92b2a719686d372a459486a851c2c5a56800eaebb` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace-errors.ts:53` | `d0b31608cf6cbd5abbd4cde2c2f15347ffad07cd0e8b8322cc06c0d208c4a664` | Decision Record | Preserved in existing ADR 0005 |
| `apps/server/src/workspaces/workspace-proxy.ts:9` | `5e2004b918593210c18f7b5dbdf83dd6521b132d2e397453cb8aac0f5cbf97c4` | Decision Record | Moved to ADR 0011 |
| `apps/server/src/workspaces/workspace-proxy.ts:17` | `bc1e22ff99a0692c71cd16a4885e6c0b986f7441d0a8fe5880e0d9ed925482fb` | Decision Record | Moved to ADR 0011 |
| `apps/server/src/workspaces/workspace-proxy.ts:29` | `083a2253c104941566fd0c51fe08b0ed9e5a1e451129988a2a5b0bfd701a2da7` | Decision Record | Moved to ADR 0011 |
| `apps/server/src/workspaces/workspace.ts:19` | `f38c5f2a6dde15d48ef40f66889f9e6b23c11749d8e0fa73b68b00d8f2e89d04` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace.ts:24` | `12c6f8f0d3075a55be40b903176bec3e325a6b84ca044d1fd5539637f65d43b9` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace.ts:26` | `b343ffe92f20aa09c9895ae3864cf2e6fdc99b87cbae9f60d8012e735f8dc139` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace.ts:28` | `0cf90d8c01175faa4af38f2ac66435539b6f809288cd7e8385a709d423b2b00c` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace.ts:36` | `595718e29e8a46ac503e8eb85bc1ae68065e98cc9af36cf792839559ac6f8a9b` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace.ts:41` | `0d6b79b33d7b4e990f367431e58eef68eaf72265765a8a46d8ba6b4fc62c9add` | Decision Record | Moved to ADR 0010 |
| `apps/server/src/workspaces/workspace.ts:43` | `0d09a55b240e45aada203d05c9480634b4a6e556d535f7cf74eda23a8981a296` | Stale | Deleted; Railway sync uses a timer, not an awaited checkpoint (`railway-workspaces.ts`, `get sync()`) |
| `tools/agents-paths.ts:4` | `c21af36524b9f400f5961637116fb192435b11727abce7b9d5e511445ebe8f8b` | Decision Record | Moved to ADR 0012 |