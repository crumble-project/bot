# Web and site comment audit

Source inventory: `/tmp/crumble-comments-remaining.json`. Lines refer to pre-edit sources. Consequential security, reliability, behavior, and verified test-environment rationale is recorded in `docs/adr/0016-web-client-decisions.md`.

| Category | Count |
|---|---:|
| Tautology | 100 |
| Stale | 1 |
| Excuse | 0 |
| Decision Record | 118 |
| **Total** | **219** |

All 219 comments were removed. No unresolved debt or issue draft resulted from this audit.

| Path | Line | Hash | Category | Action |
|---|---:|---|---|---|
| `apps/web/features/automations/timing.ts` | 32 | `a9bdf3b3cc328a1c300cfae6e76424a18a9692822005134092e48164c3e1967a` | Decision Record | Removed |
| `apps/web/features/providers/provider-logos.ts` | 34 | `a06050bb241d58c0c172aba152cfa155c7fa35a348c36d3449a496430a4ea833` | Decision Record | Removed |
| `apps/web/features/chat/composer.tsx` | 568 | `ef7b972432926fe4107f9988f9b5daaab54ad3862213faa41a1192d7bf4112a8` | Stale | Removed |
| `apps/web/features/chat/composer.tsx` | 620 | `9b8324119952318a3922ce5cf38043ed998ecf18585c84287e1813dd6a74d65c` | Decision Record | Removed |
| `apps/web/features/bot-desktop/api.ts` | 31 | `89d0b936039c87e7558feb1d42e488042498e2b1bb90c96dd49efb407c6716c6` | Tautology | Removed |
| `apps/web/features/settings/settings.tsx` | 96 | `77ddeb8884013d662c150f0734cc96ba41749e7df80c5df8756d5124802d2417` | Decision Record | Removed |
| `apps/web/features/settings/settings.tsx` | 366 | `9e1c02becbb91f2df49dd168d9631722026ae4895d28e8765b6f21285b28a3fa` | Decision Record | Removed |
| `apps/web/features/settings/settings.tsx` | 399 | `dc0b27d114493c3810abe03d3f31e133e734b76fe3851fcb2eff860398139e00` | Decision Record | Removed |
| `apps/web/features/settings/settings.tsx` | 400 | `bb2dee03b147e274efcbc8710d039e3f7b90f7b168cbf3ab987d29e6ee351158` | Tautology | Removed |
| `apps/web/features/chat/transcript.tsx` | 43 | `a782554526a3ba94d67e1111d7dd633f182bf98e62ce9afe006cb0180c774b5b` | Tautology | Removed |
| `apps/web/features/chat/transcript.tsx` | 69 | `64dda288628d0b425ddd755e70e00c54c410da68675e4bc7ab43750959fa6699` | Tautology | Removed |
| `apps/web/features/chat/transcript.tsx` | 615 | `7c30e3a584194497e4e3ae8bee7d19345c577fa68cb10f80a5c45a7a3384c593` | Decision Record | Removed |
| `apps/web/features/chat/transcript.tsx` | 621 | `4e3e418a904cfe320a612834639e80904e1b25dd9d18559e5ba9a7294f99d12a` | Tautology | Removed |
| `apps/web/features/chat/transcript.tsx` | 628 | `4e3e418a904cfe320a612834639e80904e1b25dd9d18559e5ba9a7294f99d12a` | Tautology | Removed |
| `apps/web/features/bot-chat/chat-cards.tsx` | 54 | `1fb41103286bdea55b28fb069e2f8f8130d741147fea44095f93672def8f328e` | Tautology | Removed |
| `apps/web/lib/auth-client.ts` | 14 | `627ec8df4b4a2df5efc274af4f84c7be5f8d73d8678dd009e78a5faa48f6345e` | Decision Record | Removed |
| `apps/web/lib/auth-client.ts` | 21 | `757685273bab87073a3aec4a09f365ed04b73a5036898f3f8949ca8137022bb0` | Decision Record | Removed |
| `apps/web/lib/auth-client.ts` | 30 | `ce2dabed4938cbd6c2c524612f2206552fb2cee12133e8163d33ea97a8018edb` | Tautology | Removed |
| `apps/web/features/bot-secrets/bot-secrets.dom.test.tsx` | 263 | `46188f0e0d81dc9919cc7889ca5eb7f9603f30569fd8120932baf5a5a98830ea` | Tautology | Removed |
| `apps/web/features/bot-secrets/bot-secrets.dom.test.tsx` | 307 | `52e5caf86c89e6722ec58d87409dee1df5a1e3c3471fd490ed25a4a09346659e` | Decision Record | Removed |
| `apps/web/features/bot-secrets/bot-secrets.dom.test.tsx` | 345 | `52e5caf86c89e6722ec58d87409dee1df5a1e3c3471fd490ed25a4a09346659e` | Decision Record | Removed |
| `apps/web/features/library/library.dom.test.tsx` | 16 | `64f1b8b16e36ca863d0f572022b1dd2e1f9235024c424c5d2a9deb540b214604` | Tautology | Removed |
| `apps/web/features/chat/message-card.tsx` | 13 | `5a9945391892a12255a1e7b3c6f2cba6534c2b54d853a5ad97f1cb208e37e140` | Tautology | Removed |
| `apps/web/features/chat/conversation.dom.test.tsx` | 250 | `56fa44a70b7014ff9fd37876be716b420a467d49515a8bc05a892ec2f9e39e9d` | Decision Record | Removed |
| `apps/web/features/providers/providers.tsx` | 95 | `8b8f48beb3ebb88d194698476497f0fc85171bc21c0c92a452d20cea47066694` | Tautology | Removed |
| `apps/web/features/providers/providers.tsx` | 96 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/providers/providers.tsx` | 105 | `36e7a37b8f53370b8c03b8d3199826c852b2f3e92de17e24db5e3d9922dc4863` | Tautology | Removed |
| `apps/web/features/chat/usage.ts` | 4 | `9f0532363d4ce03b7dd255d9bdbd78ccd57e39c5ff1048203db71659e7618a76` | Tautology | Removed |
| `apps/web/features/chat/usage.ts` | 11 | `60f44eeef6db80a686d460cfa5288a28d61c5ed7524fbcda7e62787596541de0` | Tautology | Removed |
| `apps/web/features/chat/usage.ts` | 17 | `717b77d1c380b9c8b1dff40cdce5d31bd8e97080d73690d1a5e77c26c5eb1a45` | Tautology | Removed |
| `apps/web/features/chat/usage.ts` | 32 | `ec5f907345ae91b01631594056fcbfac101d9a2bd651faf5de5d25609f0a850d` | Decision Record | Removed |
| `apps/web/features/chat/usage.ts` | 42 | `b615800cf2fdc1eb07aab1683fc5230965a0a94265a5c3865952bf285978c957` | Tautology | Removed |
| `apps/web/features/skills/bulk-skill-actions.ts` | 99 | `165c620cfd37eebfdc348d97896744776f8149cc5c84159ca98931aaed350e33` | Decision Record | Removed |
| `apps/web/features/skills/bulk-skill-actions.ts` | 174 | `b31e133c87099e311a3ddc89fb12db76a9889a32d919f814da8f3edb08da94a5` | Decision Record | Removed |
| `apps/web/features/skills/bulk-skill-actions.ts` | 177 | `01e32e0703ec638f102bdb6c8c05176ec8c12f3b87c880b8e553330886b49daa` | Tautology | Removed |
| `apps/web/features/providers/model-choice.tsx` | 39 | `398a2de798b12b8b192461ad792f51e398a470a35f1c215e62beba9d685806fb` | Decision Record | Removed |
| `apps/web/features/providers/model-choice.tsx` | 40 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/lib/notifications.dom.test.ts` | 40 | `ff94be52280935f0cd8e167427f56057b5b55554d306c26784e569873b5dd0b2` | Decision Record | Removed |
| `apps/web/lib/notifications.dom.test.ts` | 41 | `3d64952c776228aeb2f2e7bd518a2c14fa1d07dcb6d73589e67df2f5be928728` | Decision Record | Removed |
| `apps/web/lib/notifications.dom.test.ts` | 56 | `8335020bff1bf1c1b1f610802dcd6c358267e810becc1442406d6557bf513428` | Decision Record | Removed |
| `apps/web/features/providers/usage.tsx` | 37 | `e26cea896391c3c0acaf64fc270e869841b4d893a4ba69484456b84fc6b550e1` | Decision Record | Removed |
| `apps/web/features/providers/usage.tsx` | 137 | `429bcd795421c7ec011403de8244fc197cd8da1d72a96967d1178209794cb6fc` | Tautology | Removed |
| `apps/site/src/components/Transcript.tsx` | 663 | `2e24ee1e80a16fbede07ec56a4ec5b6c58966a61e4ead8f08a8f156f16bb43e7` | Decision Record | Removed |
| `apps/site/src/components/Transcript.tsx` | 688 | `2180063cb525ad531a93aed0496f6655e2c83a9593cb492d4da476b2fb91d547` | Decision Record | Removed |
| `apps/site/src/components/Transcript.tsx` | 689 | `6cfdf9902c8cac769560bf80a4a9c20c6257409e40b88a9b9f12b079c8e65450` | Decision Record | Removed |
| `apps/site/src/components/Transcript.tsx` | 854 | `5eee49bffea007d3f5e6e36d913d7896ad9f972b33e1c98b994a280aaa6aa9a9` | Decision Record | Removed |
| `apps/site/src/components/Transcript.tsx` | 855 | `0d49e985a17a3bc9cc95587e2b6957854fefd06ebb06546e46355c99559fbc4c` | Decision Record | Removed |
| `apps/web/features/skills/bulk-skills.tsx` | 43 | `540d0acc0ed0b5902675e1cba7377369aa35505bbf5b94aae43ea87b77a9d5a9` | Decision Record | Removed |
| `apps/web/lib/api.ts` | 174 | `a5d67d27272bd0e1d3229a4f412230506aeafc02d9b0d21c5c326dbd73ea72af` | Decision Record | Removed |
| `apps/web/lib/api.ts` | 202 | `a9743b296ae564a3ddf7b1b08ca03081a6fc7459336d852a66dd29fb81599785` | Tautology | Removed |
| `apps/web/app/shell.tsx` | 134 | `10ef563c0871890ffaa810ddde22acafb24e12ca061f9d61d7d0bb983a6f4f71` | Tautology | Removed |
| `apps/web/app/shell.tsx` | 137 | `18f9f20ddafd37d4797312e553289f93a0e97abb9e52c5b332ff70e438809dbe` | Tautology | Removed |
| `apps/web/features/voice-gateway/voice-gateway.tsx` | 396 | `4b6741810af5303dc3b568164a77ab2732fa2eecb63fc5cb6a32e966e5d9ac34` | Decision Record | Removed |
| `apps/web/features/voice-gateway/voice-gateway.tsx` | 967 | `39f486c8c8b1e2345f67aee6eac429cc1c59ac5492a3ebd7261dbc5edbbfd466` | Tautology | Removed |
| `apps/web/features/voice-gateway/voice-gateway.tsx` | 983 | `145f0386751b718718c4c25b81b98b586cdabd60771ce1cf62eb4e0c3d4f4339` | Tautology | Removed |
| `apps/web/lib/use-now.ts` | 5 | `41115187106df908c8e237708007cdc0763b3033a639493f49661d6d1163434c` | Decision Record | Removed |
| `apps/web/features/message-gateways/message-gateways.tsx` | 582 | `39f486c8c8b1e2345f67aee6eac429cc1c59ac5492a3ebd7261dbc5edbbfd466` | Tautology | Removed |
| `apps/web/components/state-diff.tsx` | 159 | `65b21badb2f16ecf5f018d8cbb609d69c108830baa613ea4e744b9c070000bf9` | Decision Record | Removed |
| `apps/web/components/state-diff.tsx` | 160 | `4e3e418a904cfe320a612834639e80904e1b25dd9d18559e5ba9a7294f99d12a` | Tautology | Removed |
| `apps/web/lib/pins.dom.test.tsx` | 29 | `98c9f8ea1f8f88c8b180711e86caa67f577ac232c4a91acf930de0fcc0d2ad04` | Decision Record | Removed |
| `apps/web/lib/pins.dom.test.tsx` | 34 | `9352b388d4dbc78ba2c4b68709a3989c20c2c0a758496a6e3d900b2732752deb` | Decision Record | Removed |
| `apps/web/lib/pins.dom.test.tsx` | 102 | `cdbd9c7b57a4591f6ea0270a728bc55316941698060646d9ced499093a65906a` | Decision Record | Removed |
| `apps/web/lib/pins.dom.test.tsx` | 144 | `24a264319c83679263710e8f33aec478bd51a33c458390a333a3fd9b4917c994` | Tautology | Removed |
| `apps/web/test/request-path.ts` | 1 | `8c508feb8966b068fb91e2a5136253c73ab8d3c781fffcdc598ae1cc6bdc1922` | Decision Record | Removed |
| `apps/web/lib/use-object-url.ts` | 5 | `4f3f54cc66755615557967476cee08362b867b310234055d436efe5e58aae594` | Decision Record | Removed |
| `apps/web/components/ui/sidebar.tsx` | 72 | `ce90a754c720e4e53766f65a6253b2143d6e108b04aa762f7a5b9f8a725af18a` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 73 | `8d7b380f9d058ed655b816a5f5505b6d7b225ae23d8bad0c7ff9a65d5dd8a807` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 87 | `08b02e77639c411f178e6ec26b1d4e5c163592df154d3a060e11a11f625f933b` | Decision Record | Removed |
| `apps/web/components/ui/sidebar.tsx` | 93 | `cf9861a41f4b1bfd21c2d1f577256b5fb3c9a88b1ee562a39e0d19a57ac1f28f` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 98 | `97d2fcd4c5c90b6886558ab36bbdfc03e5d24fd7fc670989939aed3d44b10659` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 115 | `8f5cb8ba8dc044150ebcdb19cef6b960bc2dfa44e03f818c42c42586f4cb4a2c` | Decision Record | Removed |
| `apps/web/components/ui/sidebar.tsx` | 116 | `b930d1c3253ff8d1e4dc4411524cb34992f0df4341f31bc704539ad1bc939efd` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 172 | `322956d24dcdf65449db111103824b3b88a6e19b8a86a6ba05c0a79cdd97612c` | Decision Record | Removed |
| `apps/web/components/ui/sidebar.tsx` | 173 | `97400a3301a291de686cdb3538195b268c4523c82fc3bd6c90cac9ad4146d288` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 223 | `ece22c57138b99d77adf5f44d4e00d159a902495231d1c7fd2250747db46fe3b` | Decision Record | Removed |
| `apps/web/components/ui/sidebar.tsx` | 224 | `79553260879c09dd0cd8a1141a16c0b6c7cda95d6c06ccbf7672490a1397455c` | Decision Record | Removed |
| `apps/web/components/ui/sidebar.tsx` | 232 | `5bafb4dc625c24b59f060a295f948ee97953ea3617c03360bb51ee1302472525` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 249 | `b759854ce0f3b40f451ca7dc2db70cb7e57a9cdf75e51da88f9827129cedfb6c` | Tautology | Removed |
| `apps/web/components/ui/sidebar.tsx` | 625 | `83018873eb7692997816255acd1d5aaacdecce777564ec9b4ece68178fbf5adb` | Tautology | Removed |
| `apps/web/features/activity/changes.tsx` | 67 | `fdf5e965141795edc08dc68decc60060cdb34e67789721fbae1ec7e94594b80e` | Decision Record | Removed |
| `apps/web/features/avatars/avatars.dom.test.tsx` | 25 | `39d97239625975d9f332fc6f342990100a23e32930d54d7ec460f1f608e74e51` | Decision Record | Removed |
| `apps/web/features/bot-desktop/held-action.tsx` | 35 | `d628a9b67f1c241ba024a4d791bfde7882788ba4d294c7eda2f49f0e1f130229` | Decision Record | Removed |
| `apps/web/features/bot-chat/chat.tsx` | 51 | `57b3a2c2ba3707ddd2d41aa0259212a5cbac7ac8e7240d5c743c4f208a21fa05` | Tautology | Removed |
| `apps/web/features/bot-chat/chat.tsx` | 63 | `eea0bb1c6cfcc4414931fd9386199c606e253b9fd791f791fab4b3135abfba40` | Tautology | Removed |
| `apps/web/features/bot-chat/chat.tsx` | 64 | `d63ecd0059133f854fbb36903f91e668c38c49acb4766d714290a1c8aa3dcb69` | Tautology | Removed |
| `apps/web/features/plugin-settings/plugin-settings.tsx` | 81 | `b61f0d8b5ee5e28a004d1b9e9f1a4d0cf799cafb9245acd335066ada783c4eff` | Tautology | Removed |
| `apps/web/features/bot-secrets/bot-secrets.tsx` | 550 | `786efb047abe62a52dc7ee0e4112e854817316d89909acae85353bcc8acc71b2` | Decision Record | Removed |
| `apps/web/features/settings/admin-settings.tsx` | 135 | `1109acd6c35e4e73d2a538f4f73593aee4100d190d35eef64af5ef4418a7fd38` | Decision Record | Removed |
| `apps/web/features/chat/conversation.tsx` | 59 | `f2c19934efe5cac56605ef13005d9788f0e40426a86f034a08f646d8632152f5` | Decision Record | Removed |
| `apps/web/features/chat/conversation.tsx` | 60 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/chat/conversation.tsx` | 148 | `f894c6d66a81a13ca592e6640bdfcb395cc7867d6658f61a2f1a291f83bc1a53` | Tautology | Removed |
| `apps/web/features/chat/conversation.tsx` | 149 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/chat/conversation.tsx` | 360 | `cf0399fb6b38299522196d5fbc2947ccd0c33fd708c08f09129524c8a80ab700` | Tautology | Removed |
| `apps/web/lib/session.ts` | 13 | `5d67643e72a4e35e6923a7cb52a51dc79c82567d1e0ce8eaf29003ec11ee1fbf` | Decision Record | Removed |
| `apps/web/lib/session.ts` | 30 | `6b122efea72779f64c67d7136ee6cc8395c7a1fd4ece6e37063dac32157ec3e1` | Tautology | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 21 | `f30d2425b96284d1af22f59a06c814a9f7b4bd8dfabedae7182c80e4a0180fc0` | Decision Record | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 49 | `9a4a702df92d2ea7f775003aa37c791d07c4a0d7c27c69f171f3a126b07db400` | Decision Record | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 58 | `b75b66e3084bdf148d0227b86ae069db9b82aa250132bd782800ab9260d28011` | Tautology | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 59 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 113 | `631030284c4790eaa6ba5c3321802a0e46e6888c5a764d9898c3f7d5ded7e5cb` | Decision Record | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 114 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 184 | `3dd33e3fff532b5b5d170b7dc6723822b39c6085fc6f495e799ccb63fd6d1d7f` | Tautology | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 185 | `5bcd70bb998f4f2ba866e26694fd32d0aafbf53e549eacb490bb0da8211cbc11` | Tautology | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 248 | `08bfcf91db7805c2a4267654947bead609c920ce9f62cee478f1803c1151266c` | Decision Record | Removed |
| `apps/web/features/bot-desktop/desktop.tsx` | 256 | `c1012458b6ae2e35599169353e32a122fabd1f4bff3590f6e38d2684e52bd4df` | Decision Record | Removed |
| `apps/site/src/color-scheme.ts` | 22 | `12de7738ef0f30aca08c69720e2f72aabb34e4a51781f3bc87881e67c0eb9e79` | Decision Record | Removed |
| `apps/web/features/chat/composer.dom.test.tsx` | 7 | `ad11b61ba35f31713ffb53faa501a6de3edb833253898fa21a40b24fa1493693` | Decision Record | Removed |
| `apps/web/features/chat/composer.dom.test.tsx` | 25 | `ce62dd1435e84ef7fae42741c18e807c82a1a066d08cff18efba25f34a0cf806` | Tautology | Removed |
| `apps/web/app/router.tsx` | 175 | `e9f28a0888f879898c514627fbc71aa73343ed06f95649799df0164c5b836380` | Decision Record | Removed |
| `apps/web/app/router.tsx` | 228 | `5bf23de28cefbe65c721c0c56ff3aeacfde5192bac6fe4142cb00560b95d5f0d` | Decision Record | Removed |
| `apps/web/app/router.tsx` | 391 | `e68446362c06265f2587d2f669657972d5d1c1ad4ddde1c388c9faa692baee6a` | Decision Record | Removed |
| `apps/web/components/request-card.tsx` | 34 | `3f671b1b8c995fdd912724bafcc89ee744292c6c31de2b644d211f4421876711` | Decision Record | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 49 | `8405b52afe9a5d8ee0bd352305b7b6ffde9040c7c7857aeffac83729ba6e2fa2` | Tautology | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 52 | `e0be2d38bd52ea073954f434818509db775f416d60adf12cb7d2404f2b6363c5` | Decision Record | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 80 | `3730fbf93f95bebb383a9cee508e46d48dd8a50bdc50737d78be8a9330a5014b` | Decision Record | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 135 | `b71f2851f764ba663ef7bb930468ce098b8dfe425f28ea75b939896cb43b9ea6` | Decision Record | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 136 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 263 | `f9ffb5a1da78255ba0a1b50ed8db15e73f53e898f6763f7f9dd3574bf876b26a` | Tautology | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 267 | `7e7c23bbb5d4b9e5bff938b4c940c855d1bffcbcae800c112f1594193c2f662d` | Decision Record | Removed |
| `apps/web/features/github-apps/github-apps.tsx` | 704 | `75f16a591d21556593901ac2b8f1a543e816ea12e20bae8419f6575fc5b52ce3` | Decision Record | Removed |
| `apps/web/components/bot-avatar.tsx` | 60 | `afacca5309d37f8e76b88904cc014c80c69cb726c627e26432a4ea7cf5fb0f9c` | Tautology | Removed |
| `apps/web/features/avatars/avatar-editor.tsx` | 144 | `940ba6ef6e85338ec0d42f1ac9c9f50768c146f53395ba3aaecb1e1df5e84ad2` | Tautology | Removed |
| `apps/web/features/message-gateways/message-gateways.dom.test.tsx` | 291 | `c3087dbad9ad5f626d009e21d0729cb0eb91e83888094d17c4abd2a27cb0bc7f` | Decision Record | Removed |
| `apps/web/features/providers/provider-sign-in.tsx` | 100 | `f950b316ffd748a07ebf57229d8515a4f76c7775cb6a8a9a82344b1b37623ec9` | Decision Record | Removed |
| `apps/web/features/providers/provider-sign-in.tsx` | 162 | `6eb2bf22b415a58a4329a6f404231b8e0fde41a487beaa4559e8e90bba2f5075` | Decision Record | Removed |
| `apps/web/features/providers/provider-sign-in.tsx` | 163 | `4e3e418a904cfe320a612834639e80904e1b25dd9d18559e5ba9a7294f99d12a` | Tautology | Removed |
| `apps/web/features/providers/provider-sign-in.tsx` | 197 | `abe0e2277a1fddc9a0af6d89be67b04af96af6823c7b090f8aa22456ecd54406` | Tautology | Removed |
| `apps/web/features/providers/provider-sign-in.tsx` | 198 | `4c7344a98900435035145917beeb51a007f78b87cb9eb6842005c6865c6713fb` | Tautology | Removed |
| `apps/web/features/providers/provider-sign-in.tsx` | 285 | `21bf621fd3eddf19c3202ee13c25e996395ade36b0026088facb2f78b8297f68` | Decision Record | Removed |
| `apps/web/features/avatars/avatars.tsx` | 108 | `b31b2e4fb46d5bddd177470e1556c0f0cb82463d97595b6408f54b1d7f74d0dd` | Decision Record | Removed |
| `apps/web/features/bot-chat/image-warning.tsx` | 13 | `7ab3a9c341528aa06ff7fa98f454316173ee3c236410b72b99b5240dec8aa6bc` | Tautology | Removed |
| `apps/web/features/bot-chat/image-warning.tsx` | 18 | `25daa0fde3360172cc83ebe11de682cf97226e5ef45dae3b4c053f4f39955c3c` | Decision Record | Removed |
| `apps/web/features/bot-chat/image-warning.tsx` | 31 | `209dd27aa091ce13291ae0f93da3cfd33b7d4408ce447fcbb7f31d14e0ffd984` | Decision Record | Removed |
| `apps/web/features/automations/automations.test.tsx` | 105 | `8c80244ceedbd59c21d2643a9b050de4d4751fbf348602990547ea47f61f6555` | Decision Record | Removed |
| `apps/web/components/redirect-return.tsx` | 26 | `787c908483222b8c40f2bdc9b21afb217e5b386ba845106e4980f268d9df6c0b` | Decision Record | Removed |
| `apps/web/lib/chat-attention.dom.test.tsx` | 223 | `2b1b5455d506848e822b8c964361d1fc33bd02d4ee82658c44e256d5093ab1c8` | Decision Record | Removed |
| `apps/web/lib/chat-attention.dom.test.tsx` | 238 | `d0c4ec408dcf23cb2bc28e631ef47341399219290a82861ba70bd7272059ff69` | Tautology | Removed |
| `apps/web/app/command-palette.tsx` | 25 | `2dafd49665d559b3464fa6ab06e99c2b85610c1225c445b1aa35d624abdc0f59` | Decision Record | Removed |
| `apps/web/lib/utils.ts` | 3 | `88212c1965e667a010871b28ccd9f80c8af498ab3566fde5a68de17f66ea967f` | Decision Record | Removed |
| `apps/web/lib/utils.ts` | 7 | `350f970d4089dd041ac3fe809c52b2e8e8ecb7e90b34b85ba7dea671ffce5c0d` | Tautology | Removed |
| `apps/web/features/chat/display.tsx` | 146 | `557f1097b1d147d715a0b3e207e3b59d0556919b5f3fa36ba17ab2ffe26994f1` | Tautology | Removed |
| `apps/web/features/chat/display.tsx` | 189 | `1d743216bb45d627f89c0591323e2893e198c9fe5f027379a542c6ac39847e32` | Decision Record | Removed |
| `apps/web/features/chat/display.tsx` | 379 | `b03c43837a227c38de9f86bc35f5c2344e2bad76a830d5b7d3362431700e4b2b` | Tautology | Removed |
| `apps/web/features/chat/display.tsx` | 380 | `4e3e418a904cfe320a612834639e80904e1b25dd9d18559e5ba9a7294f99d12a` | Tautology | Removed |
| `apps/web/features/password-managers/secret-source-field.tsx` | 55 | `d7c2be1c30dce124896ae3009cc88516260f74c1436817a26e7ec80852e1d743` | Decision Record | Removed |
| `apps/web/features/password-managers/secret-source-field.tsx` | 60 | `6f56c8295ff5b0deca5b3cb4f06c2f6636111f9e84b98c683907ef21cc47a941` | Decision Record | Removed |
| `apps/web/features/credentials/credentials.tsx` | 27 | `f7d0f92e55e75e04387e0f6ec3ea646bd40069322cd25f3a2a105bd78454c3a6` | Decision Record | Removed |
| `apps/web/features/chat/conversation-target.ts` | 9 | `46eb92abb038dc57d349b8f95f9149bbd02173258d1eca47d1f7bf3f9eedbace` | Tautology | Removed |
| `apps/web/components/crumble-mark.tsx` | 3 | `5321ecf07dbe658fb661b71ef6b0b8372ce123764877bf8dffead67068bb20b2` | Tautology | Removed |
| `apps/web/features/jobs/api.ts` | 19 | `c399763fd96a2a6e7519fe97d2f0503c23056696ba2ee76148d5a9ad31fdcbb1` | Tautology | Removed |
| `apps/web/features/jobs/api.ts` | 28 | `d5891f69bd2c225aa5f03fcea19f19ebe51105dc5c733786efd4eb05fd7e35c7` | Decision Record | Removed |
| `apps/web/features/github-apps/api.ts` | 36 | `3a2c140ccd58512196477f916de14a0de7447e270db76cfe05beba15e2b7ba92` | Decision Record | Removed |
| `apps/web/features/providers/api.ts` | 63 | `6815e8f60c2010308e1dfcf79303370a9cf0d3c181db76789296f09ab97e1ff5` | Decision Record | Removed |
| `apps/web/lib/pins.ts` | 12 | `cc7a718ce94057a61a5453e48f5f60f0a6cdcf9b40526ab2cbedf8d9046903c7` | Tautology | Removed |
| `apps/web/lib/pins.ts` | 20 | `e2153f75311643007387c5485e12b16bf716a74bc44bc4e6147c910599ca5c07` | Tautology | Removed |
| `apps/web/lib/pins.ts` | 22 | `fdd267ee8e813ccd6e02826626f89fb84713b9573f23692a5af8776be0b852aa` | Decision Record | Removed |
| `apps/web/lib/pins.ts` | 31 | `4032c8ae7cd9f4c4f34c57f7895f6755732bfb17e8aeed5cf3e75d1fd1ddb721` | Decision Record | Removed |
| `apps/web/lib/pins.ts` | 47 | `39bcbcac549f75759be038223ff410e15cb6c6fad4664f22181c60325104acec` | Decision Record | Removed |
| `apps/web/lib/pins.ts` | 48 | `c58da85d6b70f9df5fb9bec25b5ba6e9e45f11cecb5706ab4bbd9bc2b88919e3` | Decision Record | Removed |
| `apps/web/lib/pins.ts` | 69 | `9470cc33a53bd25194a1f83fa1db100a23f7eacda73db4a0c0c40633de31d838` | Decision Record | Removed |
| `apps/web/features/password-managers/api.ts` | 24 | `c84e564bbb2a17cb6b1f2c4e3ad8eee96b9ab5fdfd49de596421e8d98c3e0ab9` | Tautology | Removed |
| `apps/web/test/defined.ts` | 3 | `24056d49ae467b273ac824d657a150099438b0ad7f9a02b5170c5822c0a65b40` | Decision Record | Removed |
| `apps/web/features/providers/usage.dom.test.tsx` | 38 | `473999838f0be830a50ac8151af34a877b5e72f2e8567d330bdaee0b880cd126` | Decision Record | Removed |
| `apps/web/features/providers/usage.dom.test.tsx` | 69 | `bf5388f5452f8c3b3f5463a1532c6505d13afc68c6a613df4ba66dca13b31515` | Tautology | Removed |
| `apps/site/src/routes/__root.tsx` | 1 | `b440b802c2cfeac6a24eda510bd63c1f23c6ab5c52bcfe3a32a918dbad6b46c8` | Tautology | Removed |
| `apps/web/features/call-requests/api.ts` | 16 | `7f01dc95ce2b66d61e01dbb17897a4d6e2043f553e4d606bfbc397c0bc50b2fe` | Decision Record | Removed |
| `apps/web/features/call-requests/api.ts` | 31 | `49aa5c28dc25f6c6b13934fae416e15780fde249689652e97ea88430d5fc39c3` | Decision Record | Removed |
| `apps/web/lib/theme.ts` | 6 | `a67b0ec62cfee8f301ab9e1055d718409e0dddf2a0504a7f6de64db200f8584e` | Decision Record | Removed |
| `apps/web/lib/theme.ts` | 9 | `75e8314ace3fce692b81f131ae84a0e6bda3a2a3c5e475c6fc34da5b35c67acd` | Tautology | Removed |
| `apps/web/lib/theme.ts` | 79 | `73b24f7fa99aea5dc1e77b47511f9208c9a87c60224782cd128dcaf3abf66c3c` | Decision Record | Removed |
| `apps/web/features/skills/bulk-skills.dom.test.tsx` | 306 | `5c004b80d1465e9918b447f0c726ed46fc8c2ed80f86227ce37e554beb040a24` | Tautology | Removed |
| `apps/web/features/skills/bulk-skills.dom.test.tsx` | 327 | `d8d5dfb0d065acc1295cfc941bbdea651fd09074b5d7ca0f374e16bc6b0ed3f3` | Decision Record | Removed |
| `apps/web/features/skills/bulk-skills.dom.test.tsx` | 540 | `e35a5cd235b3d5df0bbfa980edbd5bb0cd878838729980a67fa2037c1b01d673` | Tautology | Removed |
| `apps/web/features/skills/bulk-skills.dom.test.tsx` | 541 | `a4e686c972514d0fd05cd6e45ce1849374d69638b6173624f0975e1738dcb318` | Decision Record | Removed |
| `apps/web/components/brand-logo.tsx` | 3 | `63b9616598ec13024c72c168e865b5cf635c31601cddb9eefcdcb779abb20c3b` | Decision Record | Removed |
| `apps/web/components/brand-logo.tsx` | 29 | `f8b834343705c105a0029ccb40c5d69459f6ec3793d88d5f1c212567c3e7d0a1` | Decision Record | Removed |
| `apps/web/components/brand-logo.tsx` | 30 | `643af667f4beb6952a09c092c408f245df806bc070c886ffa327d870e5d7602a` | Tautology | Removed |
| `apps/web/test/wait-for.ts` | 9 | `bb0a74851bcf1a8be8909222feda933b5ecd21152f18f3a04f0a695c93ce6419` | Decision Record | Removed |
| `apps/web/test/wait-for.ts` | 23 | `f9e1429558bd49995a4ccacb67599ebd2552f5f02a98270184640e2208c0bfe0` | Decision Record | Removed |
| `apps/web/test/wait-for.ts` | 29 | `3417da50bf937ff6dee9e389eda923fffaa377ab31b646dfa760fe265fdff70e` | Decision Record | Removed |
| `apps/web/lib/notifications.ts` | 174 | `c43db87c95a73cd94061e3b7183a81b8dd27c585e552e88519226abb666f09a5` | Decision Record | Removed |
| `apps/web/lib/notifications.ts` | 195 | `fd693836952a66d8c798222f4b21b3c2feea21ed935351bb412349239e269fe4` | Decision Record | Removed |
| `apps/web/tailwind-plugin.ts` | 8 | `6f49f5b18aabff2c199b412d539bb8bae98619e6f43a07f0b6402586ecc4e07f` | Tautology | Removed |
| `apps/web/tailwind-plugin.ts` | 30 | `a8180ae6e301da4cc66ab0aa6ef07dd7158386c258b50fae380b0f2f651af6a5` | Tautology | Removed |
| `apps/web/features/settings/admin-settings.dom.test.tsx` | 111 | `24a264319c83679263710e8f33aec478bd51a33c458390a333a3fd9b4917c994` | Tautology | Removed |
| `apps/web/svg.d.ts` | 1 | `0180ca7261b3492c49482a457d6bcb7b8f0a3207c9525be363f199cc5593e915` | Tautology | Removed |
| `apps/web/features/web-search/web-search.ts` | 5 | `4a6d61fc553a54e577b32b3da66595a607d2c456440d9390ae1cecb55aa96e60` | Decision Record | Removed |
| `apps/web/app/connect.tsx` | 41 | `bc8f58719fce4b7bf4b6ef797b1abecf1cece5dd95d4c223fff69bfe2ef26200` | Decision Record | Removed |
| `apps/web/app/connect.tsx` | 42 | `e8f5903603e2ba0f24ac654b7735c6eb1144b64f148463e7444b6ec768d37efe` | Tautology | Removed |
| `apps/web/app/connect.tsx` | 53 | `28fd12588af73786731d6d5093b12bec1760b0bda9259e932e3edf00f0bbe26e` | Tautology | Removed |
| `apps/web/app/connect.tsx` | 81 | `98555a453efd0b0db3118c6a8980116322a45c67ffa5f0d17e8069925c2203e1` | Tautology | Removed |
| `apps/web/app/connect.tsx` | 119 | `75a3c620c520cb4d79338235abe3fda754f2e8f8a6691520e6f6c0227aa85a95` | Decision Record | Removed |
| `apps/web/components/markdown.tsx` | 13 | `094fe81175338a81e167dddafc577705633679fe26a48a6187c08d0f70c4d5fe` | Decision Record | Removed |
| `apps/web/components/markdown.tsx` | 14 | `f13f2399d90efe3b91151ecd55db9130b8d42e56483f3d7a2602fc4c8f81b436` | Tautology | Removed |
| `apps/web/components/markdown.tsx` | 21 | `391b281df26980908cb9891a908d2d86734cd48f447b88961f8554da15307200` | Decision Record | Removed |
| `apps/web/components/markdown.tsx` | 41 | `11f7e97012c4b6942b334919977f09d4d9850fbd382acd358ffa657ff2591d65` | Tautology | Removed |
| `apps/web/components/markdown.tsx` | 85 | `b45c6b4c4a59f2fd144ddb295596ee5d032d6eca16e1856e7e5c1b99b059148d` | Tautology | Removed |
| `apps/web/components/markdown.tsx` | 100 | `c200cd0a1eedec2d1492259eeaf4afc4a58dfad65e04fbd026b7f0af45e69271` | Tautology | Removed |
| `apps/web/components/markdown.tsx` | 120 | `c2003672e690991f9ac1a7e8d432ab79dfcd44ddd4cda94466005c2ab0d5d762` | Decision Record | Removed |
| `apps/web/features/call-requests/call-request-card.tsx` | 37 | `06c360e4b2898d8d5c3837b9b88ccc00f662dcf401cf9cb96fccdcff7927534b` | Tautology | Removed |
| `apps/web/features/call-requests/call-request-card.tsx` | 248 | `e79a1eceed1cacac8ca0d543a8e056257d591ec796c7f989d29c96c80000133b` | Tautology | Removed |
| `apps/web/features/call-requests/call-request-card.tsx` | 260 | `94785ef556cfa7b4809e30322d40b10b3ff1e087ea086a164c25c24e65656ff7` | Tautology | Removed |
| `apps/web/features/call-requests/call-request-card.tsx` | 294 | `124c482ca5453c2d88b4a0ac929fd205f1beb834578878e91ef4c5517b351575` | Decision Record | Removed |
| `apps/web/features/event-sources/api.ts` | 16 | `5ea6a79878079f44855db572f2d573e2bf3f620a2db406fd895cebfdfc6a7d7e` | Decision Record | Removed |
| `apps/web/features/chat/drafts.ts` | 16 | `700ba646954d72002184ecaa8d0de31f2be10db8918f96cf9e6a53b9868eeed4` | Decision Record | Removed |
| `apps/web/features/chat/drafts.ts` | 22 | `b84b5dc35ee8023e46fd5d5a455f14b541a5d29c7738548e75f8ab774a8f8ce3` | Decision Record | Removed |
| `apps/web/features/chat/drafts.ts` | 35 | `785d9014fb85fb0c49fda04f98b88f548ed23e87d0a0dbbdce23b47e6f5746bc` | Tautology | Removed |
| `apps/web/app/activity-stream.ts` | 58 | `b7359eb4b32a34cd630ed6341f3f842bf5ef5e745943b629a3a2074d339bb391` | Decision Record | Removed |
| `apps/web/app/activity-stream.ts` | 76 | `d54d7c14aba9d6e2430315ae8aadd5754c690eaf23f5d1e3ee1e0155f3745176` | Tautology | Removed |
| `apps/web/app/activity-stream.ts` | 84 | `45dfe4dc01b2bdb8241a6887d6131675ec5f770784fe95896300a2ce8a54ee21` | Decision Record | Removed |
| `apps/web/features/jobs/jobs.tsx` | 169 | `b45bc79e36d6b4fda60eaea123bb5f94ec03ac043a53f119fc1f3fdbd592e44c` | Tautology | Removed |
| `apps/web/features/jobs/jobs.tsx` | 236 | `bd00edbe735110393264497eeb25a95771364f3be6efb6676d2a67a57a0c4b38` | Decision Record | Removed |
| `apps/web/features/jobs/jobs.tsx` | 344 | `cbf4049402f26a30d4019ee246fafc0284bcff916a51cfef270987f8f31baa39` | Tautology | Removed |
| `apps/web/features/jobs/jobs.tsx` | 345 | `3a5746491043dbae3512afaa296868324d75a261d1fbee86749ecb79d9f450e1` | Tautology | Removed |
| `apps/web/features/chat/delivery.ts` | 68 | `e42f4d8002ee878a06ca1316575161d5abc112fd756aed5cfef43997aaab2998` | Decision Record | Removed |
| `apps/web/features/chat/delivery.ts` | 73 | `1e2f93d6581292fe07186b6c5975bb9abbf926fdcfd09523982040628319ea83` | Decision Record | Removed |
| `apps/web/features/call-requests/call-panel.tsx` | 113 | `2cbac3a3551d8d4931310f7040f87aa787e6f8761b2ebfe33cc6980bccdf77ae` | Tautology | Removed |
| `apps/web/features/automations/recurrence.tsx` | 31 | `89bc22e2938fe2ba5587e857367cb881fe35622ec98e5822bb9307f63df795c0` | Tautology | Removed |
| `apps/web/features/automations/recurrence.tsx` | 35 | `243eb833a92cf667c7e003d9808decfa4953ce51ff43a723167c118b0d60acc9` | Decision Record | Removed |
