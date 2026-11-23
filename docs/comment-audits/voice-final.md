# Voice gateway comment audit

Removed all 13 inventoried comments from the three authorized source files. Lines below refer to the original files; hashes are SHA-256 of the exact UTF-8 comment text from the inventory. No executable code changed.

| Original path:line | Hash | Category | Action |
| --- | --- | --- | --- |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:113` | `e85495b0329525f9444185c0082c515ebac251eccdbe246e8edc6ff148a42cfc` | Test setup narration | Removed; arrangement directly shows composed layers. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:161` | `9259669c01a3eea2387a52233bfe784bb1b2c6f6daf12ab79fc02a1f8704669e` | Test helper narration | Removed; `restart` implementation is self-explanatory. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:946` | `33b20307fbb051771171391aa252b9dae8074ede2328a7c80a4a38fd178a3038` | Safety / test API narrowing | Removed; the helper supplies only the fields exercised. This narrows the test double, not production behavior. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:2088` | `0d88eb0254113f57c4e97abb701939d548513d9a10b98a78a216c42249210214` | Test helper narration | Removed; the helper's name and body explain the captured prompt/tools. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:2155` | `51cab4c052c9312c34c202e76c6023df17ffc4630971c749c41ab76cd40479c6` | Test helper narration | Removed; `dialed` implementation shows the ring/start-report sequence. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:2305` | `b3ddb3fd45f6fd4bfc3118af4c510eeb399981be7724f4e69d90523acf090f89` | Safety / test API narrowing | Removed; `request_call`'s executor uses only the supplied arguments. Narrowing is confined to this isolated test call. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:2307` | `8a4c2e3dba79fac0070a1cf8d8e601ac26c4fe814a63edc71f8fbb2106da6590` | Repeated safety explanation | Removed; same narrow test invocation as above. |
| `apps/server/src/voice-gateway/voice-gateway.test.ts:2588` | `4959c6c07b1dbab53a1504775eb6b531314671b9409c2a78e428d3a131b9fae5` | Test timing narration | Removed; the test's ordering/assertions establish the event being checked. |
| `apps/server/src/voice-gateway/request-call.ts:65` | `a5911a9e2b567d47a4fee81f486c4028c8c6fb21d035eebb096a17366bae6fcd` | Safety / type assertion | Removed; the value comes from the typed call-request service and is passed as JSON tool details. |
| `apps/server/src/voice-gateway/outside-calls.ts:22` | `1aa305026c5c415f9112b7392421b25421760600e983cc26a509fb2b3a0accd1` | Implementation rationale | Removed as a comment; transcript limit remains expressed by `NOTE_MESSAGES`. |
| `apps/server/src/voice-gateway/outside-calls.ts:44` | `94363713347f0fb29d9fe37bb19368b9772b290a28eb4ece416ef1fb6a9774b7` | API narration | Removed; behavior is apparent from `report` and its caller. |
| `apps/server/src/voice-gateway/outside-calls.ts:116` | `2a28af6a382774377b2d6dd674dcd409248371a7276c41115587b4d3a5ce8f71` | API narration | Removed; marker handling and return value are visible in `markOutsideCall`. |
| `apps/server/src/voice-gateway/outside-calls.ts:154` | `22f2e18a53d9e265a10e65a3995d4164b3bdbe3b0bf78cdeccf966e91bdb741b` | Domain rationale | Removed; the restart and transcript-isolation decisions are already recorded in [ADR 0015](../adr/0015-desktop-and-voice-decisions.md): restarted calls require gateway reconfirmation, and outside-call transcripts remain separate and are withheld on objection. |

## Test narrowing and issue disposition

The two `as never` test arguments are test-boundary shortcuts, not production casts or hidden behavior. The test exercises request-call argument validation and persistence without constructing irrelevant tool/context fields. No independently actionable hack was found; `/tmp/crumble-issues-voice-final.md` records this disposition. No test assertions or executable code were changed.
