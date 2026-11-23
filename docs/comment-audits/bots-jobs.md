# Bot and jobs comment audit

Each inventory comment in the owned paths was reviewed in its code context. Removal was limited to comments; executable tokens were retained. Decision Record items are summarized in `docs/adr/0017-bot-and-job-decisions.md`.

**Totals:** 140 comments: 102 Tautology, 38 Decision Record, 0 Stale, 0 Excuse. Of the 18 `SAFETY` annotations, 17 describe deliberately narrow fixtures and are Tautology; the `pi.live` serialization/ownership constraint is a Decision Record.

| Original path | Line | Hash | Category | Action |
|---|---:|---|---|---|
| `apps/server/src/bots/bots-admission.ts` | 53 | `9d0c036ea5fc75f2c81935291f7befcb678ac40632c04417339c88d6d2f1ddad` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/bots-admission.ts` | 172 | `edb908118e9148fcf0ded0a6ce252575b960705df0675e8a84039628af3e5b07` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-admission.ts` | 173 | `fe37fa8d91d9f97846c528b042d8344e9cc968f46a2c5d8e48e4947e4ddcc87a` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-ports/bot-extensions.ts` | 13 | `30ae8d125654c8ddb560b63f52b85211d836f189aa85154d82460cf2e4b4b336` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots.test.ts` | 39 | `8f59500d6da6cd568811a438bf4a779f12b78d93f0936dcad126dbaea9926825` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-submissions.ts` | 59 | `adde4e0b4c30fc454761fa76e2e9c8d6f2ed998eb3fdd010b4b15d692ffb4a8c` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/prompts.ts` | 7 | `fcaf451c997d7516d765e5b8d25f27a2b85801565f348a121f95719f8d753ee2` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/prompts.ts` | 8 | `0d506a5a7ff11e9de51ce49f710132a3911d91e28cb2a6ec7496df0fd1656490` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/prompts.ts` | 12 | `2626e326de626073680ea491031afae8daa5d4bd6c82bd3c948f8980c734bded` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/prompts.ts` | 13 | `3a3c96978869dcae83f3737d793b8990b9f2dc66a4a717de8dfaaa5f0687d17d` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/prompts.ts` | 167 | `b8720c8d442c2b3672eea2ba69e644a044966bc8ae3114b09041e73182a635f0` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/bots-reads.ts` | 56 | `dad6364c2d40d3076104e9032f4bffd87e00349b00624904713284506965757a` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-reads.ts` | 153 | `0908ffa5b826d2490da2cf9955d6e4f58eb15a5a739c16c63643999e9f4361f9` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-ports/call-notes.ts` | 6 | `95fb5060c1c2bf0bebcc1cb3671029ba46f9cfe62129b703fa9520e6bd7606c9` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-ports/call-notes.ts` | 21 | `226145191fcb210d1ce3298d87197c0b404e8cbb5ab02910e51c1162af25d0a7` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-ports/call-notes.ts` | 28 | `dcb94e7824b4f10819842ee81deaf217134acc0bebd415cc0f02e50626aaa5ce` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-store/conversation-repository.ts` | 31 | `80b778a86ce104c8c2c06bda95ae0293c3adb09e95a212cba2e384e8a8fc5710` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-announcements.ts` | 22 | `29783f5830759482bbe3299244cb7620c3deac0ffa39bf6b5d18be6aa42d9cdc` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/agents-api.ts` | 71 | `5d67db52704ff533dd6ee64795aee67c0d958b040a90eddc6f5fdc4183c6f548` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 52 | `7ddfa0e2d80ded7aec7b3af207c5707ec0a27f5d2fcca1d5f935694bc8c0b802` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 97 | `a6e41bb861138c1455d9faf385252b38b9439df87b7e718107cbea719b92b769` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 101 | `425f53d6075c93c07a52f863cbfdc8c2b7b05af9cb87b9a5665a6f30df58da42` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 105 | `a74773a59deb511b1f6c9bab69a692a20b02fc4a2a16dd428a5861d101acb3d2` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 107 | `f57328c97900995bcdb237e90f6ec1cd15a836ee0c92d1bb16f4b63eebe16193` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 121 | `d2619be58a4012845c93553bbc87b79b8904c126a01ab525d0fdfd3a34df08ba` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 128 | `9a90d5a1123eef0e691dad1fa561423ffb81bb1f28484b04a9fe31a51840089f` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/bots.ts` | 152 | `235b9e21c4e811ad69d1c4c0eac620b3096a240bb735cdb403d8d997ddea4f50` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.test.ts` | 18 | `8f66270e8bded462e0d80f78039a54e2f6b82ca909b0e83bcc8bb38cadbd0cf5` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/input-framing.ts` | 17 | `1f8631aa9797b981c97508fde211c62876205b3cfe5b3ecece558bd2fbb8993a` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/input-framing.ts` | 38 | `ed3e2bdaa5923b3e1e5d740a71789855c00249f8900a3387d2a6e0abdccc9b22` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/input-framing.ts` | 108 | `e071414b691448953a9fcb313f4c4c743ea0ceb44067bff65122217789afa6df` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/input-framing.ts` | 128 | `073afa7ad4ce6f57382a68681f5a9190f2c5e79c9bbfb3e170b3078c255c0761` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging-integration.test.ts` | 85 | `e6042b927ca24ee7695c8dd8fb37e972b04d76397da849f4f4bcf7c9e7d1851b` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging-integration.test.ts` | 102 | `e6042b927ca24ee7695c8dd8fb37e972b04d76397da849f4f4bcf7c9e7d1851b` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/coding.ts` | 24 | `01e1ee716fe6e45a0f6d78c907d3c190a31c3960a9da839c2e4bc6713d33c6f4` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/coding.ts` | 62 | `16fa77198d051ff441d15ae8e1932d6451a2728893fffe7d2bf125049c14f4a3` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/coding.ts` | 68 | `854f760b7e9e3e797afb0d56fcf1dd1fd88490557979069222e903419719b1a1` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/coding.ts` | 109 | `20c64e43f080d502dd341723710649d82ff25cdc6ee96b5eeba80d5079f7600e` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/coding.ts` | 198 | `e30ebcb57ff4c35740ffbf709eace01c1d099eeecb4b07f56d041b7f430120a3` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-ports/bot-notices.ts` | 13 | `11bc6b38ebcd0b8352d1ed2046775cbd3b79fa5efd57608a4830a6ed09710fdc` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-ports/bot-notices.ts` | 20 | `5a51bdaa985fe8bc298dcbb73b734457588d24232cdd0eacdc0dfcaea832f6c8` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 49 | `63642fcd204fef160a4cdae7af3e0322ac45bbc19faea13adfff804d747fe386` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 143 | `69e51a9406842d95fa356e270909cf6319a70caeb20ff05ba137e8fc0b1df67d` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 150 | `b34a8a26076715234e8c92c37b9a6e21e506d4d014e79e3091cb0357c553b52e` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 258 | `20bf6ae4da165e7d77e261878159aa4e6af0e0bdd3655bc0704a0f395eb42996` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 347 | `ed0e52546dc5436daa1b45de538ab6b120eca567cbcafd81e8fc21178f2da483` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 348 | `9857485e6c97f4a9210e9270be75b59dd382ea9131ef79f5b23be72dc6baa523` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 366 | `4cc48f0a863b2afde5639e92d6ad4cd7cff2ac9ee9681b965c137ada894c9806` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 367 | `3b1a2134a49bb970c270d4b0f2634df98c8620a584afbd8cc135d51c919998d0` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 377 | `9396815fbe6514002fcec66f801656b39a8e2f7f23d72b6417ebf2f5c012dcf1` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.ts` | 459 | `02972f51575d82c61e1d5668658e43dee8068d10c5355b39484a044fb8760383` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bot-activity-api.ts` | 8 | `d4bec9986014760e1cd7b0d0939e9bcf42eefe3816a1a7f996d6399618318497` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bot-activity-api.ts` | 25 | `291fe02acd4363503b89c7210add033935bae4dcc48298ce441d8ca50af02226` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bot-activity-api.ts` | 39 | `8aeb4041e053e632849b2e5713ed04c02ff64c6c14d6adec23c3990d209fcb10` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bot-activity-api.ts` | 50 | `a6ad553000f1f5ae3a168d5aa743a2ca37407e8224ffccda0effcbb6f220c4ba` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/bots-context.ts` | 22 | `70bc7903845fb4dd57e06e978d8bdf624a45352e7bd8ebec69cfdec083a83b8e` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-context.ts` | 26 | `9715a2b5132c05368ed654aee0f63ddee50e67313786c444b3eb6a4725b2c847` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-context.ts` | 49 | `427e6ce361bea1d64c29d861dd3b496fff93f3b012adcb4509e7a903498998cf` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-ports/bot-deletion.ts` | 4 | `a757a3ceafe2f9df2a737724df50cb6bf7deeb0fc61a0a47bba1cc4a4a503781` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-ports/bot-deletion.ts` | 18 | `ce947b3f7d87e99140e5798a0d7263a2b12be03e031d6e71bc1547a81844360a` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/workspace-notes.ts` | 16 | `6acae1cbabf78acbd7371039aeb6c2bfa7175651697d6969a583704630d54163` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/workspace-notes.ts` | 78 | `9f06858259fad4ce2e591d55b7e8f6e2fd5b3fe04e647992db42e66ee014dd0d` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/workspace-notes.ts` | 115 | `cf3f9cd1c493128d889b3b5334e010bb92a3263149895fe56dbc99ae8fcee8bc` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bot-messaging/coordination.ts` | 145 | `0e56d454c8d0ec9dfbbfee4f387a39967c21ea09d4e26b45c9adef4e7555c2dc` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/chat.test.ts` | 244 | `9f695698e2d31008e2bf538b9c4f3af6d3a761b77b70806cdb8f51b68d86b29a` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/chat.test.ts` | 902 | `73fb50606c14abfa9d1eab91fcd1340949d2234f2d22c56901dd4068718bbd3c` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/chat.test.ts` | 1297 | `b9ca0cafee18ff90cf817761f0d51cdf290bdfe393d4cb0bb26cb134b0db6de9` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/chat.test.ts` | 1304 | `f2c3264d5f2863323850c348a1427cd7464b25f23f9573aac3d84d7a01bfcb89` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/chat.test.ts` | 1305 | `85c5ea3c1445c5da0f88a7d809262a83c6e5e74ce18a71ae11dc7ac46e23bf02` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/chat.test.ts` | 1417 | `b9ca0cafee18ff90cf817761f0d51cdf290bdfe393d4cb0bb26cb134b0db6de9` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/service-recovery.test.ts` | 77 | `27771978db02f0ad74e4b97a86190567804b918d652696dbddd006d5817de707` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-notifications.ts` | 101 | `8765fd6408a22d10b1466d1db7f7bd82bddf50cc2067982c877c009acd2e8059` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/bot-messaging.test.ts` | 350 | `bc70622ee91c8006b4ecf9937082673596228c56a33cfc055c2a523c40322a8a` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-ports/conversation-kind.ts` | 26 | `ca590db2d24791a63e53b62fde4373911beb020345f3f6baa4fc4d3120324f91` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-ports/conversation-kind.ts` | 42 | `d9ad8e68ec5eef14c66251333f698c0a5a7be3ee431da64e76a45168501715ad` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/usage-summary.ts` | 23 | `71d272662c7d2b1712c15c18d3225d9cbb6d66814edb654fa88e27faa553116b` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/usage-summary.ts` | 32 | `d80369c4b692751431f11ab09a418fb783a0e8866e67d4c8bf371bfd5aad32cb` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-store/execution-repository.ts` | 38 | `4bfdae979c2048738b384a46180db9fa5b3e7089382ce92dc3c3cf098ca266b6` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-store/execution-repository.ts` | 40 | `c50911423b13ce409e519638337f4ddee2df6fb07d6b7b67ffa99601eb4d21d1` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-store/execution-repository.ts` | 50 | `082046b400814c7e83c84a2f46df0c20ac68b3e9fa5d690886ea4a2135fd25a4` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-store/execution-repository.ts` | 67 | `c005edd6bc6ab03cacb05f2877f8581d74d99c3865190ca179edb9e28c2aeaed` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/chat-api.ts` | 123 | `96df5d89ffde8460f103eb4defb7f3b0a9638c695138f6089d1ffee13c582eb1` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 144 | `e99eeb7b29fe6abe87fabcb480dc43e59e5add74fedcd31731bd5df44640d628` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 177 | `ad0d2ef4f6ae68fd4fe852a7cff8004e712cd3f06a4e5757bb146166c7e73ce3` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 257 | `f28682a1d6875e11a61f8c7fd585d8e77732c1b1200f207d1755ce5e0ab2c638` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 343 | `ccf458ab5f6f04a16458903aad03076da1871abb78aef48f87b0a99ba716e4e8` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 344 | `5695b6fe423bad6969f7c055924e106c53aafbe3aedf5d5d0f60cce420afdbdb` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 382 | `9daa8d8fd9bb61828ce51efabfed1466802d4097e4783de0402594a35ece788b` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 383 | `8e438649d6da868de51ab23b8de4ec76310d499b3eecc580882aaccc3dfd6f3f` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 412 | `84bcddfe0656d5cc9db0f8377cf61810ccdb44e557f7d201ec2514e1b0611b3e` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 415 | `49db407533fb8d899c7740b7628ce72b25cd3bbcb8d6c38a64b7bee4b690347d` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 481 | `f34379ae91a323cc6d47ef6eea853814312ee33af5aba5c58b52f97d118ee735` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 627 | `6f30bd9f1a9b7bf6e7872fcab91cb288b29b2cdf6fd8b32be0922c64aab1a1e5` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 1007 | `321429404e21b9d6e7555d76a3cf6ad1b15d95a45467bb6ad723e5689a3a59d1` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 1068 | `c40731cc17405e18454a797868a9c5b032db63b1231eccdf3db429a2b86dacc4` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 1069 | `bc35d829660d23d7c85d0ca7282b0fffdb2db18da6899947eb7eda9bab2db7f8` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 1070 | `4802a9a04730f5b0a22d0aa1cf05a4fe005069db57775d44c68036788db7c126` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 1083 | `8b1128579a758ee93dbf06b569fa74f096dafc86bbdfa95f112da8bac2f073b4` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/runtime.ts` | 1217 | `be0b67f8f5b83391b27333cc704b3d9b0da83016b5fdc5db9c7a5534016efcf8` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime-behavior.test.ts` | 43 | `e6042b927ca24ee7695c8dd8fb37e972b04d76397da849f4f4bcf7c9e7d1851b` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime-behavior.test.ts` | 351 | `e6042b927ca24ee7695c8dd8fb37e972b04d76397da849f4f4bcf7c9e7d1851b` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime-behavior.test.ts` | 431 | `8b98ea83cdce16743902df957a47fad79e64100ec726453e1aa2a43d0ecfcf8a` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/runtime-behavior.test.ts` | 628 | `8e5938e5fa1c892ab8b240057972dc13ca9fdcca57f559cad46f4afac67e566a` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/owner-request.test.ts` | 13 | `c77bb7b02f0852e501997b8ade5767c0e7e5ce36a2cd1d19fca5e03a91f68cc4` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/owner-request.test.ts` | 22 | `e072ab510464c2e82a2d102b00ba1ac444add9ba4ce59f41c2601ed74d8083a1` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/owner-request.test.ts` | 79 | `e072ab510464c2e82a2d102b00ba1ac444add9ba4ce59f41c2601ed74d8083a1` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-messaging/coordination.test.ts` | 71 | `154b5cc272037e0c390fb1529f81f7d6306f9079f892a3bcec21a7db20781e64` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-requests/bot-requests.ts` | 64 | `cae2bea38afc34ae8260beb5525ae80cdf9ff481db359cb62d4a3829cd2bcc97` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-requests/bot-requests.ts` | 362 | `dd90b87d38b0e0a27b074b65cfc49652cfa83a3ec4145549409e359af9d6f06a` | Tautology | Removed; executable code retained. |
| `apps/server/src/bot-store/agent-repository.ts` | 41 | `7dbd71abd8f36e9d24f565134b60cc691499c5660a75e5b4bc559bf3b9160bea` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/bots-lifecycle.ts` | 29 | `abd3aa3728f421728276e9055bd70399ce4482f4f4cf43bc1d777563c9c1b11b` | Decision Record | Removed; executable code retained. |
| `apps/server/src/bots/crash-recovery.test.ts` | 43 | `a31cb64cd90d6950b694db59f3a51e5d97dd8f72d3573c4a225fe8a1df156b56` | Tautology | Removed; executable code retained. |
| `apps/server/src/bots/crash-recovery.test.ts` | 88 | `e6042b927ca24ee7695c8dd8fb37e972b04d76397da849f4f4bcf7c9e7d1851b` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 105 | `8345b9057f6b3387b678fb29f7d516b6424a5a7093306ed5b9b8e52edb513f90` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 132 | `fdd714c636545b47442d9b2af9bc8d5b373cdd2cf4a154a0098312169c0ab5a4` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 154 | `8e11c3745a4904788f14000b824fc9a1567b2d8b4a5b6f7c98c941a85fec1329` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 171 | `9cd5a05ca5852ee5f6ed3406c5ac441f1cd4fb2f55857a7add83f902258ca1d1` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 294 | `5e462868ef5f2ef9473f1bfe77dafe6d90261c579bf0af4518d517f77aad9d22` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 311 | `b38c2e00dd72889824f5e93a8a7cda0b3bd8679058d0659b05cc0b04c14d1f42` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 395 | `9eb0de0cd208322d38eeeef4108fff4e4911616cfe689b61878f8098b40b0d45` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 441 | `dbb75d342ae5a0df6fc1df2b0ca78e75015ea47f73f08afcf9cc3fed57b13bb2` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 442 | `539a60b742ee153ac6ff31319268fad9a1e042474ecd5a79309c412eab3948ee` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 498 | `c43369f951bdaa6ff5f41a45053c4c58d7dccfbac83368dd47464937cbfaf9f2` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 499 | `650e6ff80e4dc0ee2944a34c6a86cf16a28ccb62a9a331cc1bb177d574fe3d8f` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 657 | `35f091a077e4e0b418ded2df3d6e84e1f27666f0f191bae14f409838120ea1ee` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 823 | `ea32e70e242c8d87ac636639a503135d0f929fcb42051cff1c45362301024289` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 927 | `2601c44e6f2e85795178f9bdead4c50413c7be97571b2272f53acbbca16c121d` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 928 | `d78fd6d7aed8db9dc4a47ad146e3a657f02bad93f59be51d11eea1cb3e6819f5` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 963 | `f80246a9b575a5b55eb978cb28440a28551a3be28eb4fc41d88c31a10ef58250` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 964 | `8d8536256c13f6287dfc158ee0c11e2fff9e8afd260903003e0ed2a5cc9f609d` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 965 | `9f58b9987fa6a55875b8462b8515d6eca6db7f8f57c7572536d6c54f947289da` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1012 | `069b1d7a4ee6cf1d3d6a3b53ed41158f36d60c180f19670b06eefd463054204c` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1061 | `b4ab394b09b6125e97423135fa9fa77a2c990d9cd358742415d86f9f4b682a64` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1237 | `d1ad1de83feb0106536bc07e9bbaf276fa47044f29b6508ba94fc98466f9b72f` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1357 | `99532ae999d07fcc7fece43ab3b97d328115c89f147d6b62630f33af011a5ace` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1478 | `d1ad1de83feb0106536bc07e9bbaf276fa47044f29b6508ba94fc98466f9b72f` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1525 | `d908a72b8a26a0c6a5b48a5b19e77855d22762ed9ea4ec661d92cf2b1097718a` | Tautology | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1535 | `1d8b312174251a4832c21d6e9b30fb77841a058ee3687b01a9df3994b1df329f` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1683 | `d3b84a79e9ba04949ea1324bb422232f6cad88ef55811bb2989b3fb68df63aca` | Decision Record | Removed; executable code retained. |
| `apps/server/src/jobs/jobs.ts` | 1696 | `20997af679da7b98425bd9ef8f8aa26fd40104a1e97ba72786a7cd5c31735d34` | Tautology | Removed; executable code retained. |
