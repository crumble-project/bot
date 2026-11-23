# API and automation comment audit

Scope: `apps/server/src/app/**`. Each row records the original path and line, SHA-256 of the original comment text, category, and action. Consecutive lines forming one explanation are grouped. Comments removed without an implementation change.

| Original path:line | Hash | Category | Action |
|---|---|---|---|
| `apps/server/src/app/api-requests.ts:27` | `fccb9fc057c026ce0c2107978b7c5e77500aca6ccf70dc722d53a50e4e28a3d2` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/api.test.ts:59` | `85d96f2a409d69c3e32ade859cc83b82b52c155272ab2a2fa28127f64622ca3d` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/api.test.ts:94` | `66c5270bbfc4ce7d3e6cf5c7cea98ebece391d8b1c42f13a8df6a52fe37ba10e` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/api.test.ts:1464` | `91d44549c1752de2d38646f47c3e0b086934ff85190b93aee46cb94e15b14eb8` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/auth-schema.ts:3` | `da934d612f59281de041eea0f879e93412646537d7cac5ec9aa795e910d61a76` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.test.ts:10` | `ebd1c9baa1bb19902ee1156cb5d280dd86f64dc466cf85e975c6b7fe5b06cdb2` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/auth.test.ts:168` | `2b8de09382b5b805632d9ea957877e7981952dfd08e5de702a4171e8c2bf464a` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.test.ts:313` | `88a3d330f233f1fd5eaa3a0efd6f507efbbb28114f86d24fa202fb6e3e083229` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:52` | `baa1d1b3ea83933cd900a533f0fe14361fba23061aac3e95f7c9e3aaab71ec5b` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:73` | `9256e6cf23a6c4b82fa99ab0f50fb980a5034ac5ff82458c24090dd323fca441` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:96` | `1f4dc0e13c7f2454101d37a5157bacc553729df7583a8f1722fc34d31aae7685` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:125` | `59a94615b4cea7a98689492b26192a50ac2d5a467c06e4fc0cdaed585175ab10` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:127` | `bd7927f3a7fdae1600e1411816251fbf4a36985deb6db0820b7fb7a903f3d704` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:131` | `1b6a344e9984556e3223b4b6c5df899bd3c9c18e4a7bfc94a9041ec7ae0e74cd` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:160` | `1151eeb05a34e216dbe81cf0e22593454b61e928c5b50b09e0fe0fcd0c82f9c6` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/auth.ts:201` | `efd60ccea78e0c98f190df10d0f2569fa6ba687871da670e5124e6023ee8cc27` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/builtin-plugins.ts:25` | `d7d675f0ef3452835585325bf93524c3a13dd54a333d4d12237e4d6a797abfd7` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/e2e.test.ts:51` | `e6042b927ca24ee7695c8dd8fb37e972b04d76397da849f4f4bcf7c9e7d1851b` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/e2e.test.ts:108` | `66c385f58a07a2ae296f38b92eb11d829dee80396cae6af2bbf1c45e837938f9` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/group-chat-upgrade.ts:82` | `cb5ad12176042cfe75081bbbcfffd4757a5533222ae72e5bc679ccfe32eff83f` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/group-chat-upgrade.ts:576` | `a8e6db74784b8331e72c46a7ddde7a7c1c440dea75fc94f55c46a852f2d30b44` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/invites.ts:27` | `ce4118b67e869b31c12b19e1daaa581d804cf08687e96d1efbc28a056ce5725b` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:11` | `ebd1c9baa1bb19902ee1156cb5d280dd86f64dc466cf85e975c6b7fe5b06cdb2` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:31` | `ffe098534f1938a7c326b9b6a85a1beb158d1e10f7b931484fcb1eb58fbbac47` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:52` | `744f90d43154df479659ca350943d432d56c623331906939289f1b245a05b597` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:81` | `5a181755e7c95e1b3d9c808f519608ede1402576553e83be43cf865270998aa6` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:130` | `bd110a0b94875f81d679f6afac84512585b61ff84d43354b7d5223bcf1980404` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:237` | `06d4ce2fb0c889b17c580332afa8ac3dc8cda9995f19d403ea365e1ba392f0ee` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:311` | `5a181755e7c95e1b3d9c808f519608ede1402576553e83be43cf865270998aa6` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:326` | `6cb3d3a2d8106b16d1c3a3c9afe326f58e4affd9efc60d7c2f1e29ebb6513357` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:394` | `5a181755e7c95e1b3d9c808f519608ede1402576553e83be43cf865270998aa6` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:404` | `70adb937a7ba9db58dd34d090d2d1e291be547b92e2b5553d610d268fb24039c` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:698` | `b849ed6f1efc8154fb0f17e90cd32be7a9db7bc5dd8145ffab2c8ebf2b38bbbd` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/multi-user.test.ts:729` | `b67a426d522976763a858ab5d4f8b93b1d3bcea875fa700e00c2f59552016179` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:47` | `ebd1c9baa1bb19902ee1156cb5d280dd86f64dc466cf85e975c6b7fe5b06cdb2` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:67` | `ffe098534f1938a7c326b9b6a85a1beb158d1e10f7b931484fcb1eb58fbbac47` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:85` | `744f90d43154df479659ca350943d432d56c623331906939289f1b245a05b597` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:191` | `ffe098534f1938a7c326b9b6a85a1beb158d1e10f7b931484fcb1eb58fbbac47` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:587` | `6da328401881b404e2077c0377e3b43c004c7dd5331f37224691828af374756e` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:591` | `766549d84e4a3669d8a594c08f2505b6a5b98f34a84f074c857861172252f652` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:626` | `d71409c7b3b6a87e3dbc47d20f4c5c3c82324dbe0e64e6208e4931f2994ebc29` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:738` | `6da328401881b404e2077c0377e3b43c004c7dd5331f37224691828af374756e` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server.test.ts:955` | `b41dcf745ca4416d2a36711f717b68859c50b8557be70254cd14e72ecb412b72` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server.ts:211` | `0927c3c1ccb19877e5700bed505fa99188ea029b244b72ae26500d66cfed3e85` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.ts:311` | `fd98686180fcb4cff6cabb34eb5538c7ec6535f653ad76d09761d9bd78fd0b16` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.ts:325` | `9073c7b99024005b5204e220f319efdf65a4c6f4103ed3acf8b2c631c438c536` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server.ts:350-351` | `86948468931b12cd194c3383fd08ee6f36f3ad37c88c163f2fe322ab4e2c2ae2`, `5c5afd11abe5e4914641e93eb92c0fa6215d443c5207c4406d5cf76da6af9363` | Decision Record | Grouped; recorded in [ADR 0013](../adr/0013-api-and-automation-decisions.md) |
| `apps/server/src/app/server.ts:382` | `056366365c2c440ca55f54460f351330f4e38209623c77418f0ce615ff0539b5` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.ts:474` | `4eaabea9fefc25df1fe72889a95ceefd6a008dccf3772f6d060a399d32f5c917` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server.ts:505` | `fa1550b74bd1e7db66e6da8fe652246261b2b10ccff4a16a7590c5065c9998ea` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/tenant.test.ts:50` | `54245b181d10a3524fa0bcfe922ad0fb1edd606c29e2dea0211e6e00817ea5a4` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/tenant.ts:118` | `de83f8cdbc7001657794ddc6f849729d7202c5a88992a07d7ea9a486476b6065` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/tenant.ts:120` | `49815beb001da91ad869647c2dd56dbb93d938a2424abb36f37fc7559d6e3803` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/tenant.ts:326` | `a8605c23b3c52155737635c4b5cc8574dc1b25f4922a40c52f4451baa305e331` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/tenant.ts:337` | `1c5c00b5d0a35f31bbc413924858809dd792194b8297f4ffef72ab24b2c287f4` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/tenant.ts:388` | `34b09ed8a1875178f9e8fc5a78bc842b1a19aebd4cf141f645a472ccca5ed224` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/web-ui.ts:23` | `1be14fcaf6535770b2ab7379ff3a20f5d15f8df8da7a0e6deaa94e48730d6868` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/web-ui.ts:46` | `7e2278eb195ea18eece61ced0693d32b534ca79d2ad7d6256494408d4ceb559f` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/web-ui.ts:53` | `b33e0c3d1e684c29f96efed2bed5dda3e641eb1b05dc67362a6014f6c6925a5f` | Stale | Removed; obsolete route path documented in code |
| `apps/server/src/app/data-dir.ts:6` | `0868b10b4adec304919a1d8944b5689a5954f68f3e4e1512d7600c582df9c013` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/server-settings.ts:57` | `775e95222b27fdae0a903885a145fe2e466044b01af4a5e88c155c54b856e343` | Tautology | Removed; behavior unchanged |
| `apps/server/src/app/server-settings.ts:62` | `1ed555036a449d197b7dd800550b2dee34822c1d584f981b9184cc237daff40d` | Decision Record | Removed; behavior unchanged |
| `apps/server/src/app/data-lock.ts:36` | `ac9ae2a36dbcfcabd5c809bb9cd7d40b37e82fdfcae5a9e1b39b477d1abdb23e` | Decision Record | Removed; behavior unchanged |
