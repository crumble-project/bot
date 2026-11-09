# State-machine correctness review

## Verdict

Reviewed all **92 inventory groups**. Final classifications are **25 P1, 10 P2, and 57 OK**; none is P0 or P3.
These groups map to **20 confirmed P1 root causes and 8 P2 findings**, not 35 independent defects.
A group inherits its highest finding; some findings cross group boundaries.

No critical cross-account exploit or catastrophic corruption was established. The most important confirmed issues concern password exposure, authorization invalidation, cancellation, and durable progress.
Passing tests do not establish these invariants: both full baseline runs passed while controlled reproductions demonstrated missing transition coverage.
No application code, existing tests, dependencies, or configuration were changed. This report is the only repository file added by this review.

## Remediation status

- **F03 implemented:** GitHub owner mutations now use transactional authorization identities, and sign-out removes local state before remote revocation. All 20 focused tests pass, including installation-token routing after a stale refresh. Independent review found no meaningful issues. See the [specification](designs/github-owner-authorization-invalidation.md) and [F03 evidence](#finding-f03).
- **F02 implemented:** Persisted OAuth generations prevent older sign-in and refresh work from restoring local authorization after sign-out or client changes. All 20 focused tests pass; independent review found no issues. See the [implemented specification](designs/mcp-oauth-invalidation.md) and [F02 verification evidence](#finding-f02). Sign-out does not revoke the remote grant.
- **F01 implemented:** Computer-use calls refresh persisted password-exposure records before dispatch and refuse dispatch if refreshing fails. Historical password scrubbing and Chromium-instance screenshot rules remain unchanged. All 34 focused tests pass; independent review found no issues. See the [implemented specification](designs/password-exposure-refresh.md) and [F01 verification evidence](#finding-f01). The audit classifications and counts remain historical findings, not a count of unresolved defects.

## Scope and revision

Scope: the 92 groups in [the original inventory](implicit-state-machines.md), covering `apps/server/src`, `apps/web`, and the landing-page demonstration.
Native clients, sibling repositories, historical migrations, and unrelated dependency internals remain outside scope.

The inventory and review started at `d5de8135f8c1acfab803f84ab4d99cef3613cc4d`.
The checkout changed outside this review to `95570dd0519ca22b8a3361b26af8e23c59f687a0` while analysis was running.
That change affected bot runtime/read code, related contract schemas, and supporting documentation/tests.
The runtime review re-read the changed implementation and updated its references. Other reviewed feature implementations were unchanged across these revisions.
The final review is anchored to **`95570dd`**, not a claim that every statement in the old inventory remains current.
In particular, current runtime snapshots no longer offer the old partial-text opt-in.

## Evidence and classification

- **P0:** Confirmed critical correctness or security defect.
- **P1:** Confirmed bug with meaningful user impact. This category includes rare, fault-dependent bugs; likelihood is ranked separately.
- **P2:** A specific plausible failure requiring verification or clarification of the intended contract.
- **P3:** Maintainability concern without demonstrated correctness impact.
- **OK:** Adequate within the inspected contract and scenarios, not proof that no bug exists.

Each detailed group reconstructs state, transitions, invariants, illegal combinations, guards, cancellation/concurrency, persistence/recovery, and relevant test assertions.
Each finding includes its minimal failure sequence, affected invariant, references, reachability limits, and deterministic regression proposal.
Global finding IDs are F01–F28. Their numbering remains stable across the confirmed and verification queues.

A finding is confirmed only where the actual caller path and required transitions were traced or reproduced.
An arbitrary setter invocation, missing test, possible clock schedule, or injected dependency result alone does not prove the complete production consequence.
Reproductions use unmodified production implementations with controlled boundary fixtures, temporary databases, and synthetic secrets.
They distinguish observed local behavior from source-proven persistence or remote consequences.
No mutation testing, physical authenticator, live browser/desktop, real provider, simulator, emulator, or workspace backend was used.

### Executed baseline

Root command, with live backend opt-ins disabled:

```sh
CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run test
```

| Run | Passed | Failed | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1,060 | 0 | 118 | 12.54 seconds |
| 2 | 1,060 | 0 | 118 | 11.86 seconds |

Each run discovered 1,178 tests across 137 files. Skipped backend cases are not passing durability or integration evidence.
Partition-specific commands and exact assertions appear in the detailed sections; those counts overlap and must not be added together.
Tests were inspected for the observable invariant they enforce. No claim of mutation resistance is made.
The throwaway reproduction tests intentionally assert the observed failure; a proposed regression reverses those assertions to require the invariant.

### Independent verification and rejected overclaims

Independent skeptical passes checked delivery, infrastructure, desktop safety, authorization, frontend feature, and secret-write findings.
The synthesis separately reran the runtime admission, job, group, desktop-output, reply-restoration, and passkey reproductions.
Key qualifications:

- **F01:** The desktop reproduction uses shared fill-store fixture state and synthetic driver text, not a real password-bearing browser or a durable fill repository. Cache reuse and persistent-store scope are source-proven. Plaintext disclosure requires a surface exposing the value. Fixture image admission does not prove password pixels. This is P1, not a proved cross-bot exploit or P0.
- **F02:** MCP sign-out deletes local authorization; it does not revoke the remote grant. The older completion defeats local invalidation, not remote revocation.
- **F03:** GitHub owner-state resurrection is reproduced with encrypted SQLite. Usable tokens after successful real GitHub revocation are not proved. False owner identity and incorrect owner-versus-App credential routing still establish user impact.
- **F06:** Duplicate script admission is source-proven against once-per-event and interrupted-not-rerun behavior. Duplicate shell side effects were not executed. This is not a demand for exactly-once external completion after a mid-command crash.
- **F08:** The initial stranded-control P1 was downgraded to P2. Documentation promises retained owner control after closing; frontend cleanup implements automatic hand-back. The reproduced race cannot establish which policy is intended. No automatic-release fix is prescribed before resolving that conflict.
- **F13:** Consumer death is reproduced with one injected enqueue defect. A real transient SQLite fault was not injected. Recoverable driver failures can reach that edge, but their frequency is unmeasured; ordinary internal enqueues do not by themselves establish lock contention.
- **F21:** Independent verification strengthened the MCP leak from fake-client ownership loss to an open default-production HTTP/SSE transport surviving scope disposal. Exhaustion remains unproved.
- **F22:** Password signup and bundled-web passkey signup have transaction protection. The candidate is the custom passkey verification path with `createSession` false or omitted, not a generic signup bypass.
- **F26:** Narrowed to cancellation before transcript commit admission. Ordinary cancellation after durable commit admission and backend-Harness failure can follow different recovery paths. The injected publication rejection does not establish those stronger variants.
- The owner-control check/dispatch candidate was rejected. Completion of an already admitted action after takeover does not prove a new unauthorized admission.
- Normal scoped shutdown is not equivalent to process death. SQL statement-failure experiments do not establish physical disk durability or every SIGKILL schedule.

Full logs, temporary scripts, and independent verification records remain under `/tmp/crumble-state-review-d5de813/` on the audit machine.
They are not checked-in tests. Detailed proposals identify the repository seams needed to make durable regressions.

## Priority interpretation

The confirmed queue is ordered by security/correctness severity, then exploitability, likely triggering conditions, and blast radius.
This is an engineering ranking, not a numerical risk model. A rare persistence fault can rank highly when it repeats arbitrary work.
P2 findings have a separate verification queue; their position does not upgrade uncertainty to confirmation.
For each row, follow the finding link for exact source references, sequence, invariant, tests, and reproduction proposal.

## Confirmed findings

| Rank | Finding | Groups | Evidence and likelihood | Exploitability and blast radius |
| --- | --- | --- | --- | --- |
| 1 | **[F01 — P1: Resumed desktop jobs miss later password-exposure knowledge](#finding-f01)** | J14 | Reproduced at real computer-use seam; cache reuse source-proven. Likelihood: Workflow/surface-dependent. | No demonstrated remote exploit; needs an observable surface containing a filled password. Blast radius: One bot desktop's model-visible password data. |
| 2 | **[F02 — P1: Late MCP OAuth completion restores signed-out authorization](#finding-f02)** | I09 | Reproduced with gated token exchange. Likelihood: Narrow asynchronous overlap. | Owner sign-out overlapping an existing authorization attempt. Blast radius: One integration's authorization. |
| 3 | **[F03 — P1: GitHub owner refresh recreates signed-out token state](#finding-f03)** | I11 | Reproduced local credential resurrection; remote token validity qualified. Likelihood: Near-expiry overlap. | Sign-out overlapping refresh; no cross-account primitive proved. Blast radius: One App's owner identity and credential selection. |
| 4 | **[F04 — P1: Successful late admission revives cancelled bot work](#finding-f04)** | R01, R02 | Real service/runtime/SQLite reproduction; parent rerun. Likelihood: Admission-latency-dependent. | Ordinary Send/Stop overlap. Blast radius: One stopped turn and any tools it subsequently runs. |
| 5 | **[F05 — P1: Two processes can claim the same data directory](#finding-f05)** | H02 | Two-process real lock reproduction. Likelihood: Rare concurrent startup. | Operational startup overlap, not remote access. Blast radius: Entire shared data directory; corruption not reproduced. |
| 6 | **[F06 — P1: Script trigger admission can repeat after acknowledgment failure](#finding-f06)** | I01, I02, I03 | Source-proven durable-prefix/retry path; duplicate shell side effects not executed. Likelihood: Rare failure window. | Recoverable acknowledgment failure or process crash. Blast radius: Affected script's arbitrary side effects. |
| 7 | **[F07 — P1: Settled group turns can retain an unadvanced consumption cursor](#finding-f07)** | R06, R07 | Real SQL failpoint and subsequent input reproduction; parent rerun. Likelihood: Rare persistence failure window. | Cursor-write failure or crash after settlement. Blast radius: One member/group; old instructions re-presented as new. |
| 8 | **[F09 — P1: Concurrent guarded demotions can leave zero admins](#finding-f09)** | H08 | Real authenticated public handlers and SQLite reproduced. Likelihood: Low. | Two authorized admins concurrently self-demote. Blast radius: Server administration until restart/bootstrap repair. |
| 9 | **[F10 — P1: Failed multi-field login saves leave a durable mixed login](#finding-f10)** | J16 | Real SQLite statement-failure reproduction. Likelihood: Rare failure window. | Partial storage failure or process crash. Blast radius: One saved login's fields. |
| 10 | **[F11 — P1: Concurrent settings patches diverge published state from SQLite](#finding-f11)** | H09 | Real gated public PATCH reproduction. Likelihood: Schedule-dependent. | Authorized concurrent disjoint patches. Blast radius: Server-wide effective settings until reload or correction. |
| 11 | **[F12 — P1: Old admission erases a newly rescheduled occurrence](#finding-f12)** | I01 | Real Scheduler/Store reproduction. Likelihood: Admission-latency-dependent. | Owner edits one-time automation during admission. Blast radius: One scheduled occurrence. |
| 12 | **[F13 — P1: One enqueue defect terminates live push ingestion](#finding-f13)** | I12 | Real consumer with injected enqueue defect; real storage-fault frequency unmeasured. Likelihood: Low/unquantified. | Recoverable persistence fault; not ordinary internal enqueue contention. Blast radius: All later push-worthy replies for one account. |
| 13 | **[F14 — P1: Stopping a question-waiting job leaves originating work open](#finding-f14)** | J02, J04 | Real runtime/durable jobs reproduction; parent rerun. Likelihood: Deterministic in that state. | Ordinary Stop after a posted question. Blast radius: One originating/delegated task remains running. |
| 14 | **[F15 — P1: A question immediately releases its own workspace grace hold](#finding-f15)** | J05 | Real tool/afterTool ordering reproduction; parent rerun. Likelihood: Deterministic; other holds can mask consequence. | Any coding question with nonzero grace. Blast radius: One bot workspace's waiting services/processes. |
| 15 | **[F16 — P1: Question replacement retains the previous question's answer draft](#finding-f16)** | W11 | Real component Q1-to-Q2 reproduction. Likelihood: Timing/workflow-dependent. | Question answered elsewhere and replaced between polls; owner later submits. Blast radius: One job's next decision. |
| 16 | **[F17 — P1: Late summary populates a removed-and-rejoined membership](#finding-f17)** | R09 | Real group/model-gate reproduction; parent rerun. Likelihood: Low; potentially long inference window. | Owner removes/rejoins member during summary inference. Blast radius: One member's retained working context. |
| 17 | **[F18 — P1: Refused reply restoration drops its reply target](#finding-f18)** | W01, W02 | Real conversation hook reproduction; parent rerun. Likelihood: Deterministic on affected rejection path. | Ordinary correction after first-send rejection. Blast radius: One reply; group recipients can change. |
| 18 | **[F19 — P1: Late conditional passkey options cancel newer manual sign-in](#finding-f19)** | W05 | Real component/auth client/abort service reproduction; parent rerun. Likelihood: Network/browser-dependent. | Reordered options responses on supported passkey host. Blast radius: One manual sign-in attempt. |
| 19 | **[F20 — P1: Successful gateway save overwrites a newer local draft](#finding-f20)** | W17 | Real component deferred-response reproduction. Likelihood: Deterministic under delayed response and later edit. | Ordinary typing while saving. Blast radius: Unsaved gateway edits in one view. |
| 20 | **[F21 — P1: Competing MCP opens lose connection ownership](#finding-f21)** | I08 | Real manager with gated clients; ownership leak reproduced. Likelihood: Concurrency-dependent. | Concurrent cold discovery or reconfiguration. Blast radius: Leaked client/transport resources for one integration. |

## Verification queue

| Rank | Finding | Groups | Evidence and likelihood | Exploitability and blast radius |
| --- | --- | --- | --- | --- |
| 1 | **[F22 — P2: Custom passkey registration may double-consume a one-use invite](#finding-f22)** | H06, H07 | Nontransactional store race reproduced; complete signed ceremonies not executed. Likelihood: Unverified. | Valid invite plus custom createSession=false/omitted API flow; bundled web uses true. Blast radius: Potential extra durable accounts. |
| 2 | **[F23 — P2: Interrupted auth-first account deletion has no cleanup replay](#finding-f23)** | H03, H08 | Source-traced durable prefix; killed-process scenario not executed. Likelihood: Rare/unverified. | Crash after auth deletion before workspace/files cleanup. Blast radius: Orphan account files; hosted resource cost not established. |
| 3 | **[F24 — P2: Skill apply may select a candidate different from the preview](#finding-f24)** | W13 | Source-traced separate reads; crossed-check reproduction not executed. Likelihood: Low/unverified. | Intervening update check changes stored candidate. Blast radius: Shared skill instructions/documents. |
| 4 | **[F25 — P2: Manifest-converted GitHub credentials can be lost before saving](#finding-f25)** | I10 | Source-traced sequencing; remote one-use recovery premise unverified. Likelihood: Low/unverified. | Lookup/persistence failure after conversion. Blast radius: One App setup attempt and converted private credentials. |
| 5 | **[F08 — P2: Desktop departure has conflicting control-retention policies](#finding-f08)** | W09 | Timing-dependent behavior reproduced; violated intended invariant unresolved. Likelihood: Policy conflict; no unconditional liveness bug claimed. | Ordinary navigation; docs promise retention but cleanup releases control. Blast radius: One bot desktop control-retention and pause semantics. |
| 6 | **[F26 — P2: Pre-publication cancellation may orphan a pending approval](#finding-f26)** | J11 | Injected gate error reproduced; full runtime pre-admission cancellation not executed. Likelihood: Narrow/unverified. | Cancellation after hold insertion before transcript commit admission. Blast radius: Stale approval/notice; no action execution or approval bypass proved. |
| 7 | **[F27 — P2: Late daemon stream acquisition may outlive its departed bridge](#finding-f27)** | J20 | Source-traced real asynchronous acquisition; remote cleanup outcome unmeasured. Likelihood: Latency/timeout-dependent; unverified. | Bridge disconnect during stream acquisition. Blast radius: Orphan transient processes/streams in one workspace. |
| 8 | **[F28 — P2: Timestamp equality can classify a duplicate write as new](#finding-f28)** | R08, R10 | Real receipt collision reproduced; downstream scheduling impact unverified. Likelihood: Narrow/unverified downstream impact. | Duplicate request observes same clock value and relevant progress occurs between effects. Blast radius: Group budget, queue, and answer-notification bookkeeping. |

## Group classification index

| Group | Protocol | Classification | Findings |
| --- | --- | --- | --- |
| [R01](#group-r01) | Bot input admission and recovery | **P1** | [F04](#finding-f04) |
| [R02](#group-r02) | Cancellation, disablement, and deletion | **P1** | [F04](#finding-f04) |
| [R03](#group-r03) | Continuous-chat opening and runtime activation | **OK** | None established |
| [R04](#group-r04) | Reply publication barrier and watch lifetime | **OK** | None established |
| [R05](#group-r05) | Transcript turn boundary scanner | **OK** | None established |
| [R06](#group-r06) | Per-member turn queue | **P1** | [F07](#finding-f07) |
| [R07](#group-r07) | Group turn publication and settlement | **P1** | [F07](#finding-f07) |
| [R08](#group-r08) | Bot-turn budget and answer notification | **P2** | [F28](#finding-f28) |
| [R09](#group-r09) | Late-member summary gate | **P1** | [F17](#finding-f17) |
| [R10](#group-r10) | Group transcript write receipt | **P2** | [F28](#finding-f28) |
| [R11](#group-r11) | Delegation reservation and composite result | **OK** | None established |
| [R12](#group-r12) | Reporter-first job question routing | **OK** | None established |
| [R13](#group-r13) | Merged activity pagination | **OK** | None established |
| [R14](#group-r14) | Learning-review admission and budget | **OK** | None established |
| [R15](#group-r15) | Vision description acquisition | **OK** | None established |
| [R16](#group-r16) | Interactive provider sign-in | **OK** | None established |
| [R17](#group-r17) | Serialized provider credential mutation | **OK** | None established |
| [R18](#group-r18) | Claude Code replay, stream, and process lifetime | **OK** | None established |
| [R19](#group-r19) | Single-use model admission and response capture | **OK** | None established |
| [R20](#group-r20) | Claude status refresh cache | **OK** | None established |
| [I01](#group-i01) | Scheduled admission | **P1** | [F06](#finding-f06), [F12](#finding-f12) |
| [I02](#group-i02) | Event-run delivery | **P1** | [F06](#finding-f06) |
| [I03](#group-i03) | Script automation execution | **P1** | [F06](#finding-f06) |
| [I04](#group-i04) | Event relay handshake, acknowledgment, and reconnect | **OK** | None established |
| [I05](#group-i05) | Gateway connection ownership | **OK** | None established |
| [I06](#group-i06) | Discord client and outbound request settlement | **OK** | None established |
| [I07](#group-i07) | Gateway receipt delivery | **OK** | None established |
| [I08](#group-i08) | MCP live connection cache | **P1** | [F21](#finding-f21) |
| [I09](#group-i09) | MCP OAuth sign-in | **P1** | [F02](#finding-f02) |
| [I10](#group-i10) | GitHub App setup and installation token cache | **P2** | [F25](#finding-f25) |
| [I11](#group-i11) | GitHub owner authorization and rotating tokens | **P1** | [F03](#finding-f03) |
| [I12](#group-i12) | Push ingestion, durable delivery, and presence | **P1** | [F13](#finding-f13) |
| [I13](#group-i13) | APNs request settlement | **OK** | None established |
| [I14](#group-i14) | Installed-skill check and update | **OK** | None established |
| [I15](#group-i15) | Skill aging and per-turn write authorization | **OK** | None established |
| [I16](#group-i16) | Mixed search fallback and vendor initialization | **OK** | None established |
| [H01](#group-h01) | Server bootstrap and shutdown | **OK** | None established |
| [H02](#group-h02) | Data-directory ownership | **P1** | [F05](#finding-f05) |
| [H03](#group-h03) | Tenant initialization, restoration, and removal | **P2** | [F23](#finding-f23) |
| [H04](#group-h04) | Account runtime acquisition and recovery | **OK** | None established |
| [H05](#group-h05) | Authentication bootstrap and admin establishment | **OK** | None established |
| [H06](#group-h06) | Sign-up admission and passkey account creation | **P2** | [F22](#finding-f22) |
| [H07](#group-h07) | Invite-link consumption | **P2** | [F22](#finding-f22) |
| [H08](#group-h08) | Account authorization and removal | **P1** | [F09](#finding-f09), [F23](#finding-f23) |
| [H09](#group-h09) | Settings persistence and publication | **P1** | [F11](#finding-f11) |
| [H10](#group-h10) | Account encryption-key migration | **OK** | None established |
| [H11](#group-h11) | SSE connection lifetime | **OK** | None established |
| [H12](#group-h12) | Shared coordination and timer gates | **OK** | None established |
| [J01](#group-j01) | Job delivery, reporting, and announcement | **OK** | None established |
| [J02](#group-j02) | Job stop versus admission | **P1** | [F14](#finding-f14) |
| [J03](#group-j03) | Job question and answer race | **OK** | None established |
| [J04](#group-j04) | Composite turn completion | **P1** | [F14](#finding-f14) |
| [J05](#group-j05) | Question grace hold | **P1** | [F15](#finding-f15) |
| [J06](#group-j06) | Shared workspace lifetime | **OK** | None established |
| [J07](#group-j07) | Desktop readiness and stream holds | **OK** | None established |
| [J08](#group-j08) | Microsandbox resume versus replacement | **OK** | None established |
| [J09](#group-j09) | Railway recovery, checkpoints, and liveness | **OK** | None established |
| [J10](#group-j10) | Taking control and observation invalidation | **OK** | None established |
| [J11](#group-j11) | Intent check and suspended acting call | **P2** | [F26](#finding-f26) |
| [J12](#group-j12) | Computer-use observation validity | **OK** | None established |
| [J13](#group-j13) | Browser attachment, navigation, and driver recovery | **OK** | None established |
| [J14](#group-j14) | Password exposure and screenshot safety | **P1** | [F01](#finding-f01) |
| [J15](#group-j15) | Credential/login request fulfillment | **OK** | None established |
| [J16](#group-j16) | Secret and login save validation | **P1** | [F10](#finding-f10) |
| [J17](#group-j17) | Secret cache freshness and invalidation | **OK** | None established |
| [J18](#group-j18) | Password-manager session lifetime | **OK** | None established |
| [J19](#group-j19) | Viewer ticket, bridge, and input filter | **OK** | None established |
| [J20](#group-j20) | Workspace relay, proxy, and tunnel protocols | **P2** | [F27](#finding-f27) |
| [J21](#group-j21) | Credential interception and certificate acquisition | **OK** | None established |
| [J22](#group-j22) | Scoped lifecycle ports | **OK** | None established |
| [J23](#group-j23) | Persisted pending authorization records | **OK** | None established |
| [W01](#group-w01) | Optimistic bot chat delivery | **P1** | [F18](#finding-f18) |
| [W02](#group-w02) | Composer clearing, restoration, and attachment conversion | **P1** | [F18](#finding-f18) |
| [W03](#group-w03) | Chat subscription ownership and reconnect | **OK** | None established |
| [W04](#group-w04) | Account activity follower | **OK** | None established |
| [W05](#group-w05) | Sign-in, sign-up, and passkey ceremony | **P1** | [F19](#finding-f19) |
| [W06](#group-w06) | Session teardown and account switching | **OK** | None established |
| [W07](#group-w07) | Provider sign-in dialog | **OK** | None established |
| [W08](#group-w08) | MCP/GitHub authorization redirect return | **OK** | None established |
| [W09](#group-w09) | Desktop control, viewer connection, and wake | **P2** | [F08](#finding-f08) |
| [W10](#group-w10) | Held-action freshness and decision UI | **OK** | None established |
| [W11](#group-w11) | Job observation, question answers, and export | **P1** | [F16](#finding-f16) |
| [W12](#group-w12) | Bot requests and secret request cards | **OK** | None established |
| [W13](#group-w13) | Skill discovery and update review | **P2** | [F24](#finding-f24) |
| [W14](#group-w14) | Partial-success bulk skill operations | **OK** | None established |
| [W15](#group-w15) | One-time invite/address reveal | **OK** | None established |
| [W16](#group-w16) | Automation editor and admission feedback | **OK** | None established |
| [W17](#group-w17) | Gateway configuration adoption | **P1** | [F20](#finding-f20) |
| [W18](#group-w18) | Notifications, unread state, and audio unlock | **OK** | None established |
| [W19](#group-w19) | Asynchronous rendering resource lifetime | **OK** | None established |
| [W20](#group-w20) | Chat detail/job/mobile panel coordination | **OK** | None established |
| [S01](#group-s01) | Interactive demonstration playback | **OK** | None established |

## Shared implementation and transactional boundaries

These recommendations follow invariant ownership and demonstrated failure sequences, not visual similarity between workflows.
They describe follow-up work only; nothing was implemented.

### Admission and cancellation ownership

**R01/R02, F04:** Bot admission and cancellation need one conversation/execution admission boundary.
A product-row compare-and-set alone cannot prevent a late runtime submission after cancellation.
The owner must fence delayed configuration/submission, coordinate cancellation with admission, and handle an already-admitted submission explicitly.
Preserve durable request identity and test stop before admission, during admission, and after admission.
Do not replace the durable runtime with a second generic scheduler.

### Product-store commit boundaries

- **R06/R07, F07:** Successful member-cursor advancement and terminal group settlement belong in one repository transaction, or a recoverable checkpoint phase. Both already live in the product database. A keyed semaphore and uninterruptible region do not protect against process death.
- **I01–I03, F06:** Script-run admission must retain a unique occurrence/event identity, joined to trigger acknowledgment or discoverable on retry. A durable random run ID plus transient overlap exclusion cannot deduplicate an earlier admission. This is distinct from promising exactly-once shell side effects.
- **I01, F12:** Schedule advancement needs the occurrence/version it admitted. A conditional update can preserve a newer owner edit; blindly rereading the latest schedule and clearing it loses that distinction.
- **J16, F10:** Login field writes/deletions and metadata need one local persistence boundary after external validation. A transaction around only one field or only preflight does not close the mixed-generation window. Keep external notices outside the transaction, with explicit delivery semantics.
- **H08, F09:** The last-admin predicate and role/removal mutation share one authorization invariant. Count checks and role changes cannot be independently serialized statements. Include every operation that can reduce the admin set.
- **H09, F11:** Settings merge, validation, persistence, in-memory replacement, and publication need ordered ownership. Persist multikey updates transactionally; publish a version that includes all preceding accepted patches.

These are separate transactions over different aggregates. A single universal transaction helper does not make them one domain machine.

### Delayed result invalidation

**I09/I11, F02/F03:** Credential mutation must cover sign-out, login completion, and refresh, not only competing refreshes.
R17's existing serialized provider-credential mutation is a useful implementation reference because it owns the same invalidation invariant.
A shared keyed serialization/fencing primitive is justified if it can preserve each provider's token-rotation and cancellation rules.
Do not unify OAuth protocols or credential schemas merely because both name pending and authorized states.
Holding a lock across a long external exchange also needs a defined sign-out ordering; an invalidation epoch can let explicit removal fence old work.

**R09, F17:** Summary ownership needs a membership incarnation and captured history boundary, not just group/bot identity.
This uses the same stale-result principle, but not necessarily the same implementation as credential mutation.

### Desktop-scoped confidentiality and control

**J14, F01:** Password-exposure knowledge belongs to the bot desktop/browser lifetime, shared across cached job computers.
Use one desktop-scoped registry or merge fresh durable exposure state at each tool boundary.
Keep record-before-typing and fail-closed reads. Job exclusivity is not cache invalidation.

**W09/J10, F08:** Resolve explicit retention versus departure auto-release before changing authority acquisition/cleanup.
Any scoped-claim design must identify the actual owning client; unconditional hand-back can interfere with another tab.
Viewer tickets, RFB connections, and persistent owner control are different lifetimes and must not be merged accidentally.

**J11, F26:** If verified, the gate must own pending-hold cleanup across publication and waiting.
That does not require making the product database and durable transcript one transaction.

### Resource acquisition ownership

**I08, F21:** MCP opening needs per-server single-flight or a compare-and-publish that closes every losing client/transport.
Existing disconnect generations correctly address invalidation, not competing successful opens in the same generation.
Identity-aware eviction must not let an obsolete connection remove a newer owner.

**J20, F27:** Late stream acquisition needs the departed-owner guard already present in the desktop viewer attachment path.
A small acquired-after-close pattern can be shared if both callers preserve ordered writes and cleanup.
A generic network state-machine framework is not justified by this one candidate.

**H02, F05:** Cross-process directory ownership requires a real atomic ownership primitive with safe stale-owner reclamation.
An in-process semaphore cannot protect another process. Keep this separate from async client acquisition helpers.

### UI identity and recovery envelopes

- **W01/W02, F18:** Text, files, and reply target form one failed-send recovery envelope. The current Boolean recovery contract splits one invariant across parent and composer. Preserve newer owner edits/selections while restoring the rejected envelope.
- **W11, F16:** Question identity owns answer draft, selection, and mutation state. Key/reset that local editor by question ID; server current-question checks cannot detect text drafted for a different question.
- **W17, F20:** A successful save acknowledges the submitted version, not every newer local edit. Adopt the server baseline without discarding a newer draft, or disable editing while saving.
- **W05, F19:** Passkey attempt ownership includes fetching options and acquiring the browser ceremony. A cancellation helper that only owns an existing browser signal cannot fence an older options response.

These are distinct UI protocols. A generic form reducer would hide the important identity differences rather than enforce them automatically.

### Background failure containment and recovery intent

**I12, F13:** The live push-ingestion consumer needs explicit per-item failure ownership and restart/retry behavior.
A drain worker cannot recover replies that never reached its durable outbox. Merely restarting the dead loop can also lose the already-taken reply.
Use the existing outbox as the durability boundary and define what happens when admission itself fails.
Do not merge push acceptance, provider delivery, and owner display confirmation.

**H03/H08, F23:** If the crash candidate is confirmed, deletion intent must survive auth-user removal and replay independently of live-user restoration.
A durable tombstone/cleanup record can own that multi-resource operation. Do not blindly delete every unknown directory.

**I10, F25:** Confirm manifest-code replay semantics before adding a converted-App staging protocol.
If conversion is genuinely one-use, persist its recoverable result before unrelated network lookup.

## Suggested follow-up order

1. Add deterministic regressions for F01–F04 and close their confidentiality, authorization, and cancellation boundaries.
2. Protect durable progress and admission identity: F05–F07, F09–F12, and F14–F15.
3. Address background resource/notification failures and frontend identity loss: F13 and F16–F21.
4. Verify P2 schedules and resolve F08's product contract before implementing proposed remedies.

This order is not a claim that low-likelihood failures are frequent. Use the risk columns to adjust for deployment and workflow exposure.
Do not convert all 92 groups to one FSM library. Several existing explicit models, locks, generations, and transactions are adequate.

## Overall coverage limits

All 92 groups received implementation, transition/reachability, recovery, and test-assertion analysis.
The audit did not prove all possible interleavings or formally verify every invariant.
Dependency internals were inspected only where needed to resolve caller serialization, commit, cancellation, authentication, or transport behavior.

The full baseline passed twice, but 118 cases were skipped each time. Real VM/Railway behavior, physical browser/credential behavior, provider revocation, and power-loss durability were not tested.
No production secrets or real user databases were used. Controlled SQLite faults were confined to temporary databases.
No mutation experiments or repository test changes were made, so test-effectiveness claims are limited to the assertions and reproduced transition gaps described here.

The verdict does not label a complex implicit machine defective merely because it is implicit.
No additional P3 issues were manufactured to fill a category; the remaining 57 groups are OK within the stated inspection scope.

## Detailed review navigation

- [Chat execution, visibility, activity, learning, and vision](#runtime-review): R01, R02, R03, R04, R05, R13, R14, R15.
- [Group chats and delegation](#groups-review): R06, R07, R08, R09, R10, R11, R12.
- [Provider and integration authorization](#auth-flows-review): R16, R17, R18, R19, R20, I08, I09, I10, I11, J23.
- [Automation, gateway, and push delivery](#delivery-review): I01, I02, I03, I04, I05, I06, I07, I12, I13.
- [Secrets, skills, search, and lifecycle ports](#secrets-skills-review): I14, I15, I16, J15, J16, J17, J18, J21, J22.
- [Server and account infrastructure](#infrastructure-review): H01, H02, H03, H04, H05, H06, H07, H08, H09, H10, H11, H12.
- [Jobs and workspace recovery](#jobs-workspaces-review): J01, J02, J03, J04, J05, J06, J07, J08, J09.
- [Desktop safety and transport protocols](#desktop-review): J10, J11, J12, J13, J14, J19, J20.
- [Web delivery, sessions, and authentication](#web-core-review): W01, W02, W03, W04, W05, W06, W07, W08, W18, W19.
- [Web feature workflows and landing-page playback](#web-features-review): W09, W10, W11, W12, W13, W14, W15, W16, W17, W20, S01.

The detailed sections retain scope-specific test commands and execution limits. The overall baseline and verification qualifications govern synthesis.

<a id="runtime-review"></a>

## Chat execution, visibility, activity, learning, and vision

### Scope, baseline, and evidence

Reviewed exactly **R01–R05 and R13–R15 (8 groups)** from `docs/implicit-state-machines.md`, tracing production implementations, their API/service callers, repositories, relevant Pi Durable dependency behavior, and tests. Read the complete review brief, inventory, canonical `GLOSSARY.md`, and root/bot `AGENTS.md`. No repository files were changed. No real providers, credentials, workspaces, simulators, or emulators were used.

The checkout moved externally from the inventory baseline `d5de813` to **`95570dd0519ca22b8a3361b26af8e23c59f687a0`**. Per the updated instruction, this review is anchored to **current 95570dd**, and all repository line references below use that snapshot. I inspected `git diff d5de813 HEAD --stat`, the scoped implementation diff, and contract schema diff. Admission/lifecycle/activity/learning/vision/transcript code is unchanged; current runtime removes opt-in partial-text snapshots and the corresponding test. Current `api-contract.ts` removes `chatEventsInput.partial` and uses `snapshotInput` for SSE; `api-responses.ts` removes the partial-text opt-in description. I read the current runtime in full and ran all tests/reproduction against current code. Target copies in `/tmp` were comparison aids only, not the reviewed runtime.

**Verdict:** one distinct **P1 finding**, affecting R01 and R02; six other groups OK within the inspected scope. No P0 or P2 findings. Findings are correctness judgments, not claims that every possible behavior is tested.

### Per-group analysis

<a id="group-r01"></a>

#### R01 — Bot input admission and recovery — P1 (F04)

`apps/server/src/bots/bots-submissions.ts:54–95` resolves the conversation and enabled owner, validates uploads, checks a durable `(conversationId, requestId)` identity and content digest, then creates a `pending` execution before admission. `apps/server/src/bots/bots-admission.ts:37–72` reuses a known submission ID or prepares and submits the input with its original request ID. At `:94–110`, successful admission writes `running`, records the ID, clears retained attachments, and starts one scoped monitor per execution with `FiberMap.run(..., { onlyIfMissing: true })`. `apps/server/src/bots/bots-outcomes.ts:36–74` waits independently of the HTTP caller and records terminal outcomes uninterruptibly. The host and durable harness databases are not one transaction: a crash between runtime submission and host ID storage is handled by durable request deduplication, not a new input identity.

Terminal admission guards (`bots-admission.ts:113–126`) prevent ordinary replay of `done`, `cancelled`, or a `failed` execution with a submission. They do **not** protect an admission already awaiting configuration: F04 demonstrates `cancelled → running → done`. The monitor membership guard is not an admission/cancel mutex. Recovery (`apps/server/src/bots/bots-lifecycle.ts:56–62`) revisits active rows only; failed pre-ID admission can be retried by its caller using the original identity.

Executed tests include `apps/server/src/bots/chat.test.ts:252`, “restarts keep one chat and one durable input per request” (same chat and one input), `:599`, “recovery resubmits attachments that were stored before a crash” (uploads reach recovered inference), and `apps/server/src/bots/crash-recovery.test.ts:19`, “recovers durable execution and preserves one user turn” (real SIGKILL/reopen and exact user/assistant transcript). These enforce deduplication/recovery, but none tests a **successful** admission completing after stop.

<a id="group-r02"></a>

#### R02 — Cancellation, disablement, and deletion — P1 (F04)

`apps/server/src/bots/bots-lifecycle.ts:22–37` snapshots active executions of the conversation, records `cancelled` before invoking runtime abort, sends a change notification, and emits settlement afterward. This ordering correctly prevents an aborted wait from normally recording failure first. `apps/server/src/bots/bots-notifications.ts:57–68` rereads the current execution and refuses outcomes over `cancelled` or `done`; monitor outcome settlement uses this guard. However, admission's direct `executions.update(...status: "running")` bypasses it (F04). Public send and stop routes (`apps/server/src/bots/chat-api.ts:77–91`, `:103–107`) do not share a lock.

Disablement (`apps/server/src/bots/agents-api.ts:66–73`) stops before saving `enabled: false`; deletion (`bots-lifecycle.ts:64–75`) stops all conversations, prepares dependent cleanup, removes runtime storage, deletes the product row, then executes cleanup. These are ordered side effects, not a durable deletion transaction. A crash can leave partially completed cleanup; there is no persisted deletion-progress recovery in this layer. No separate deletion defect was established. F04 also weakens stop-before-disable: a previously captured owner can finish configuration after stop; individual tools may independently reject disabled access, which is not equivalent to cancelling admission.

Executed `apps/server/src/bots/bots.test.ts:106`, “a failed admission leaves an execution cancelled meanwhile cancelled,” gates a runtime submission, cancels, then **rejects** submission and asserts cancelled status, null error and one cancellation settlement. It validates the guarded error path, not the unconditional successful-admission update. `apps/server/src/bots/chat.test.ts:347`, “report a cancelled execution as settled,” checks cancellation delivery. `apps/server/src/bots/runtime-behavior.test.ts:571` checks cancellation of an already-running generation, not precommit admission.

<a id="group-r03"></a>

#### R03 — Continuous-chat opening and runtime activation — OK

`apps/server/src/bots/bots-chat.ts:29–47` owns a per-bot opening semaphore. Within it the code rereads the owner and existing continuous-chat row, unarchives the existing row if necessary, or opens/configures the runtime root and stores its stable reference. The semaphore covers both the asynchronous runtime opening and product-row creation, so simultaneous first uses cannot both observe an absent row. The lock is process-local, consistent with one owning account runtime; there is no claimed cross-process admission guarantee.

`apps/server/src/shared/harness-files.ts:35–51` caches the opening promise before later callers can open another harness, evicts failed openings, and closes acquired storage if construction fails (`:21–32`). `apps/server/src/bots/runtime.ts:473–514` installs tool, vision, conversation-kind, job-knowledge and contributed extensions before opening; it publishes `opened = harness` to hooks before calling `resume()` for enabled bots. The hypothesis that vision hooks necessarily see an undefined harness on normal resume is therefore rejected. Each submission calls configuration again (`runtime.ts:585–632`, `:783`), refreshing model choice, instructions, skills and extensions. This refresh is also the genuine asynchronous boundary used by F04, but the chat-opening invariant itself holds.

Durable root identity survives product-row creation interruption; retry opens the same root rather than inventing a second chat. Enabled runtime resume is distinct from host execution-monitor recovery; disabled bots are not automatically resumed by opening. Executed `apps/server/src/bots/bots.test.ts:78`, “concurrent first uses of a bot's chat open one chat,” asserts exactly one opening and one returned chat identity across three callers. `apps/server/src/bots/runtime.test.ts:31`, “submits through a real durable harness and reopens,” and `apps/server/src/bots/chat.test.ts:252` verify durable reopening. No concurrent reconfiguration mutation fault injection was performed.

<a id="group-r04"></a>

#### R04 — Reply publication barrier and watch lifetime — OK

At the current commit, `apps/server/src/bots/runtime.ts:140–148` strips the in-flight generation message from public live state; `:194–201` removes assistant messages explicitly stopped with `error`/`aborted`. `:207–237` inspects durable submissions and uses the earliest **placed input of the requested chat** as a cutoff, suppressing subsequent assistant messages until that input settles. Global bot entry IDs alone do not cause an unrelated group/job conversation to hide chat replies. Completed tool-round text can become visible when an unsuccessful turn ends; the implementation does not promise to delete every previously committed successful tool round when cancelling a later round.

Snapshot reads the transcript before attaching the live view, then applies the active-input guard (`runtime.ts:860–910`) to avoid publishing a tool-round entry committed during attachment. In `history`, the same filter applies unless the internal caller explicitly requests active assistant entries (`:991–1012`). **95570dd always sets `partial: ""`** (`:894`) and removes the SSE partial opt-in; neither ordinary snapshots nor the SSE route offer live assistant text. The older inventory snapshot's optional partial output is not a current behavior.

`runtime.ts:1027–1051` attaches a watch before the initial fresh snapshot, starts delivery after snapshot callback completion, and stops it both on setup failure and normal disposal. Dependency `apps/server/node_modules/@earendil-works/pi-durable/dist/harness/events.js:38–74` atomically attaches the committed watch on the session line and buffers before start; this rejects the simple snapshot/listener lost-event hypothesis. `apps/server/src/bots/chat-api.ts:122–133` registers both host and runtime cleanup with the SSE scope. Restart/reconnect obtains a new snapshot, not event replay.

Executed tests `apps/server/src/bots/runtime-behavior.test.ts:571`, `:611`, `:641`, `:685` assert cancelled final text hidden, complete reply publication, intermediate tool text hidden until settlement, and cross-conversation isolation respectively. No watch-overflow or simultaneous disconnect fault injection was run.

<a id="group-r05"></a>

#### R05 — Transcript turn boundary scanner — OK

`apps/server/src/transcript/transcript.ts:840–865` scans one conversation in ascending order from the inclusive persisted input ID, carries the dependency cursor across pages of 200, includes the first entry, and stops immediately before the **next** recognized input. Input kinds are centralized as `MESSAGE_ENTRY`/`USER_ENTRY` at `:275–277`. The `entries.length` test is deliberately retained across pages: a next input that is first in a subsequent page still terminates the old turn. Empty pages with continuation follow the cursor rather than implying exhaustion. `:867–873` removes the original input before flattening model messages; `:891–894` extracts assistant text/reactions.

Callers provide the input ID obtained from the durable submission record, not an arbitrary user-supplied scan floor: `apps/server/src/bots/runtime.ts:680–706` resolves submission status and conversation; `:1015–1024` reads its response. `apps/server/src/group-chats/group-turn-outcome.ts:43–62` and `apps/server/src/learning/turn-report.ts:147–180` reuse the scanner. These boundaries are per-conversation, not adjacent global entry numbers. Normal queued inputs belong to later turns; no evidence was found that these callers use a steering input as an independent completed turn.

The scanner is a transient read over durable entries and needs no startup state. It does not make the entire multi-page read atomic, but callers use settled submissions; a later next input bounds the earlier result rather than expanding it indefinitely. Executed `apps/server/src/bots/chat.test.ts:252` and `apps/server/src/learning/learning-review.test.ts:111` indirectly exercise response/report extraction. `apps/server/src/transcript/transcript.test.ts:120`, “pages in stable chronological order and keeps structural events,” tests history pagination, **not** a scanner turn spanning the 200-entry boundary. There is no directly inspected test asserting that scanner-specific multi-page boundary; that is absent coverage, not a demonstrated bug.

<a id="group-r13"></a>

#### R13 — Merged activity pagination — OK

`apps/server/src/activity/activity.ts:232–252` decodes `k` (last emitted total-order key), per-agent `h` hints (`null` initial / string page start / `false` exhausted), and change cursor `c`. `:306–354` scans at most five history pages per bot, tags every candidate with its originating page's start, and records a scan floor if more history exists. `:370–390` merges newest queue heads but stops below the maximum incompletely scanned floor; `:444–471` saves a page-start tag when a bot still has unconsumed candidates, otherwise advances to its scanned end. Thus bounded scans may intentionally return an empty/short page with continuation rather than falsely declare exhaustion.

The rejected simple loss hypothesis was “unconsumed fetched items disappear after pagination”: their page tags deliberately reload the page, and strict `k` comparison removes already-emitted items. Item keys include timestamp, numeric entry and stable event ID, so multiple tool blocks in one entry retain a deterministic order. `apps/server/src/activity/activity-api.ts:30–65` validates the cursor, obtains currently authorized account bots and feeds real runtime history with active assistant entries explicitly enabled; activity's visibility contract differs intentionally from final chat replies. No process-local pagination ownership exists; the encoded cursor survives server restart. This is not a frozen transcript snapshot under concurrent new writes, and no such guarantee is claimed here.

Executed `apps/server/src/activity/activity.test.ts:265`, “pages bots and changes newest first without gaps or repeats,” compares the complete accumulated event-ID sequence to independently enumerated expected events for unfiltered, tool-result and change filters, checks page size, and requires final cursor exhaustion. Its two-entry fixture pages force the bounded-scan/continuation behavior. `:29` exercises authenticated real durable tools through the feed. No malformed-timestamp or concurrently edited-history reproduction was executed; arbitrary corrupt rows were not assumed reachable.

<a id="group-r14"></a>

#### R14 — Learning-review admission and budget — OK

`apps/server/src/learning/learning-review.ts:65–90` updates durable per-bot counters from the completed turn report; `:140–188` computes the character budget, chooses skill/memory scope, resets applicable counters, opens an anchored review, stores a pending row, and ensures that pending row is removed after the review run. `:191–210` suppresses simultaneous duplicate turn IDs with a transient `running` set and clears it in a finalizer. Normal completion notifications are scoped subscriptions/fibers (`:265–305`), not unowned promises. Different bot/job turns may have independent reviews; this is not a per-bot exclusive execution lock.

`apps/server/src/learning/review-kind.ts:37–65` owns the generation spending map and rejects a request **before dispatch** when cumulative serialized-message characters would exceed the stored budget. This is a character proxy, not a provider-billed-token guarantee. The map does not remove successful review entries (a process-lifetime retention concern, not a separately graded correctness bug). The review anchor and review metadata are durable; counters reset before opening/pending persistence, so failure there consumes the threshold without a completed review. Recovery intentionally drops pending reviews rather than resuming them (`learning-review.ts:213–228`): abort errors are logged and pending metadata removed. Opening an enabled harness can briefly resume its tasks before abort; I did not demonstrate a review tool mutation in that recovery window and do not promote it to a race finding.

Executed `apps/server/src/learning/learning-review.test.ts:111` asserts actual skill patch, review-model usage, recorded learned-change source, counters and pending-row cleanup; `:243` asserts only rounds after the last write count; `:287` verifies below-threshold behavior and removal of a manually inserted pending review. `:210` verifies no skill mutation/learned changes with a small budget, but does not independently assert every dispatched request's accumulated size or prove rollback of writes made before a later budget failure. No claim of transactional rollback is made.

<a id="group-r15"></a>

#### R15 — Vision description acquisition — OK

`apps/server/src/vision/vision.ts:355–390` hashes image data, coalesces identical images for a generation, and replaces images only when a configured vision model is required by the requesting model. `:301–334` reads durable conversation-scoped `VisionDescriptions` and runs missing descriptions concurrently. `:270–299` first consults the generation task's failure memo, invokes the model, and memoizes unavailable/failed results so the same task does not repeatedly retry a failed image. Failures are deliberately not permanent description-cache entries: a later turn may try again.

`vision.ts:244–267` commits successful descriptions and any spent usage together through the harness transaction, avoiding a successful cached description without its usage accounting. `:136–168` propagates a thrown error when the abort signal is aborted instead of turning cancellation into an explanatory stand-in. Commit also receives the context. A process crash after remote inference but before durable commit can repeat that external inference; no exactly-once remote billing guarantee exists. Successful descriptions survive restart; task failures follow durable task memo semantics rather than an account-wide failed-image blacklist. Hash collisions/prefix ambiguity were not treated as reachable correctness failures without evidence.

The follow-up tool (`vision.ts:447–499`) explicitly performs fresh inference, locates an image in the current conversation and returns usage/error metadata; it does not mutate the cached original description. Executed `apps/server/src/bots/chat.test.ts:710` asserts actual substituted prompt blocks, retained image attachment and positive usage; `:743` asserts one inference reused across turns and a reopen; `:786` asserts failure stand-in followed by a second-turn retry; `:811` asserts fresh follow-up question routing; `:858` asserts image-capable models bypass description/tool offering. No cancellation-during-parallel-description fault injection was run.

### Local findings

<a id="finding-f04"></a>

#### F04 — P1, high confidence, R01/R02: an admission completing after stop revives a cancelled execution and runs the bot

**Status:** reproduced using unmodified production `Bots` service, `AgentRuntime`, actual durable harness and real SQLite product store, with a faux model and a deterministic gate in the existing extension-discovery callback. This is not a mock implementation of admission or cancellation.

**Primary references (repository paths, current 95570dd):**

- `apps/server/src/bots/bots-admission.ts:94–110`: after awaited `submit`, unconditionally writes `status: "running"` and starts monitoring.
- `apps/server/src/bots/bots-admission.ts:113–126`: terminal-status/enabled checks occur only before the asynchronous run and operate on the supplied execution snapshot.
- `apps/server/src/bots/bots-lifecycle.ts:22–37`: stop cancels currently active product rows, then aborts whatever runtime work presently exists.
- `apps/server/src/bots/runtime.ts:585–595`, `:769–815`: configure awaits model/extension preparation before durable `conversation.submit`; abort is independent at `:1054–1063`.
- `apps/server/src/bots/bots-notifications.ts:57–68`: terminal guard exists for outcomes, but admission does not use it.
- `apps/server/src/bots/chat-api.ts:77–91`, `:103–107`: independent publicly reachable send and stop handlers; `apps/server/src/bots/agents-api.ts:66–73` also relies on stop before disablement.

**Minimal triggering sequence and required preconditions:**

1. An enabled bot has its continuous chat open. An owner starts a send; the product execution becomes `pending`.
2. Runtime submission reaches asynchronous configuration and waits (e.g. extension discovery/model refresh), **before** committing the input to Pi Durable. The reproduction gates `RuntimeCallbacks.extensions`, a real existing await at `runtime.ts:593`.
3. The owner stops the bot chat. Stop sees the pending row, records `cancelled`, and completes runtime abort. There is no newly admitted input yet for the harness to abort.
4. Configuration resolves. The original submit now commits a new input, admission overwrites the cancelled row with `running`, and monitoring eventually writes `done`. The model produces an answer after stop has returned successfully.

**Violated invariant:** cancellation is terminal for an execution and stop covers an already-accepted pending input. The successful path can perform the forbidden transition `cancelled → running`; guarding later monitor outcomes cannot repair admission that already revived cancellation.

**Public reachability/concurrency proof:** send and abort are independent API requests without a shared conversation lock or generation. The per-bot semaphore protects only `chat()` opening; `FiberMap` protects only duplicate monitor installation. The wait occurs in real asynchronous runtime configuration, so this is not an invented interleaving between synchronous database reads/writes. Pi Durable serializes its own commits and deduplicates request identity, but aborting the conversation before the future input exists does not reserve a permanent “no more inputs from old admission” state. Its submit operation legitimately starts a new run afterward.

**Observed output:**

Command: `bun /tmp/crumble-state-review-d5de813/admission-repro.ts`

```text
after abort [ "cancelled" ]
send returned running
final execution done
visible messages [ "hello", "ANSWER AFTER STOP" ]
```

The gate was released only after `bots.abort(chat.id)` completed. The script waits for the real durable submission before reading the final execution/transcript. Reproduction uses current 95570dd unmodified production code.

**Retry/restart consequences:** once overwritten to running, active-execution startup recovery will monitor/recover the work rather than preserve cancellation. If the crash instead happens after cancellation and before the delayed submission, the process loses that transient admission and the cancelled host row is not recovered. These are distinct windows; a process crash is not necessary for the normal bug. A repeated same-request send after terminal cancellation is ordinarily blocked, but the already-running admission bypasses that guard.

**Severity/likelihood/blast radius:** P1: explicit stop can be ignored and bot inference/tool work can start after the owner is told it stopped. This affects one pending input/bot per race, requires an overlap with asynchronous admission, and needs no attacker or corrupt database. Slow model refresh/extension acquisition widens the window. Disablement/deletion share stop semantics; separate downstream tool authorization and deletion interleavings were not independently reproduced and are not inflated into additional findings.

**Existing-test gap:** `apps/server/src/bots/bots.test.ts:106` covers a submission that **rejects** after cancellation; it never reaches the unconditional update at admission `:99`. Runtime cancellation test `runtime-behavior.test.ts:571` starts after durable admission. Both pass while this defect exists.

**Deterministic regression test proposal at a real seam:** promote the `/tmp` reproduction into a normal test using `standaloneBots`, real `AgentRuntime`, `runtimeCallbacks`, real Store, faux provider, and `Promise.withResolvers` gates. Open the chat before arming the gate; pause only the subsequent `extensions` call. Await gate entry, await `bots.abort`, assert cancelled, release gate, await send/runtime settlement, and assert the execution remains cancelled and the faux model never receives this input. **Expected:** no admitted user turn/answer after stop, or a safely withdrawn input before inference; **actual:** running/done plus answer, as above. Add the same gated sequence for stop-before-disable if that path is changed.

**Invariant ownership / repair boundary:** serialize admission and stop under a conversation-owned cancellation epoch/barrier (or equivalent protocol), invalidating in-flight admissions before they commit and rechecking after asynchronous preparation. A guarded product-row update alone prevents status resurrection but does **not** prevent the already-delayed runtime input from starting work. Conversely, simply adding another abort after submission risks aborting newer legitimate work. The boundary must identify the old admission and prevent/withdraw that admission specifically. No general-purpose FSM rewrite is justified by this finding.

### Executed experiments and coverage limits

1. `bun test apps/server/src/bots/bots.test.ts apps/server/src/activity/activity.test.ts apps/server/src/learning/learning-review.test.ts apps/server/src/transcript/transcript.test.ts apps/server/src/bots/runtime-behavior.test.ts apps/server/src/bots/chat.test.ts apps/server/src/bots/service-recovery.test.ts`
   - **50 pass, 0 fail, 259 expectations, 2.97 s**.
2. `bun test apps/server/src/bots/crash-recovery.test.ts apps/server/src/bots/runtime.test.ts`
   - **3 pass, 0 fail, 8 expectations, 842 ms**. The crash fixture is hermetic; it SIGKILLs its own faux-model subprocess.
3. `bun /tmp/crumble-state-review-d5de813/admission-repro.ts`
   - Reproduced F04 deterministically; exact output above. No Effect code was authored for the script; existing support helpers provide the service layers.

Total: **53 existing tests passed; one real-implementation gated reproduction confirmed a missing case**. No mutation testing, no whole-repository check, no CI changes, no UI/browser runs. R05 scanner-specific multi-page coverage and R14 recovery-resume mutation timing were not dynamically investigated. External provider billing, account shutdown, group scheduling, and deletion-port cleanup internals were traced only as needed for these eight groups, not independently audited. Final repository status remained the preexisting untracked `docs/implicit-state-machines.md` only.

<a id="groups-review"></a>

## Group chats and delegation

Reviewed the seven assigned groups using the provided checkout. `git rev-parse --short HEAD` returned `95570dd`, not the brief's `d5de813`; a scoped `git diff d5de813 HEAD` verified that all group/delegation implementations, jobs boundary code, repositories, test support and examined tests are identical. The examined runtime differs only in snapshot partial-output options outside this partition; its submit/wait/answerJob/turnWork logic is unchanged, but runtime line references below are checkout line numbers (add 10 for submit/wait and 12 for answerJob/turnWork at d5de813). The inventory was treated as a hypothesis. Read the review brief, repository instructions, canonical glossary, production implementations, relevant callers, persistence, and the test assertions identified below. No repository files were edited. All repository references below are relative to the bot repository root; dependency references are explicitly identified.

### Results and experiments

- Local findings: **2 P1, 1 P2, 0 P0/P3**. P2 distinguishes an established internal defect from an unverified meaningful production failure sequence.
- Group classifications: R06 P1, R07 P1, R08 P2, R09 P1, R10 P2, R11 OK, R12 OK. Shared findings are counted once, not once per affected group.
- Executed existing tests:
  ```sh
  bun test apps/server/src/group-chats/group-chats.test.ts apps/server/src/group-chats/group-transcripts.test.ts apps/server/src/group-chats/group-turns.test.ts apps/server/src/bot-messaging/bot-messaging.test.ts apps/server/src/bot-messaging/bot-messaging-integration.test.ts apps/server/src/bot-messaging/coordination.test.ts
  ```
  Result: **58 pass, 0 fail, 228 assertions, 6.31 seconds**. Expected fault-injection logs appeared for failed summary and unavailable workspace cases.
- Executed real-implementation reproductions, stored outside the repository:
  - `bun /tmp/crumble-state-review-d5de813/repro-r09.ts`: stale summary applied to a rejoined membership; output quoted in F17.
  - `bun /tmp/crumble-state-review-d5de813/repro-r10.ts`: a duplicate durable write reports `created: true` under a controlled equal clock reading; output quoted in F28.
  - `bun /tmp/crumble-state-review-d5de813/repro-r07.ts`: a fault at the actual SQLite cursor-update seam leaves a settled turn at cursor zero; real recovery does not repair it, and the next input repeats the old instruction in the same private conversation. Details in F07.
- None of the scripts reimplements the production transition algorithm. R09 and R07 use the real group service, repositories, durable runtime and faux model provider through existing test-support constructors. R10 calls the real `GroupTranscripts`. No Effect code was authored, no services or credentials were used, and no mutations of repository code or tests were performed.

### Per-group analysis

<a id="group-r06"></a>

#### R06 — Per-member turn queue — P1 (F07)

Durable member state is `conversationId`, `cursor`, `pending`, `pendingBotStarted`, `summary`, and `joinedAt` (`apps/server/src/group-chats/group-chat-repository.ts:19–28`); pending-generation symbols and two sets of keyed locks are transient (`apps/server/src/group-chats/group-chat-context.ts:27–39`). Owner posting writes the transcript before queueing selected members (`apps/server/src/group-chats/group-chat-post.ts:94–124`). Queueing replaces the symbol and combines bot-started flags so owner work dominates (`apps/server/src/group-chats/group-turn-engine.ts:59–90`). Startup captures a version before asynchronous input/admission; it consumes pending only if that version still matches (`:209–216`, `:249–304`). This correctly rejects the tempting lost-follow-up hypothesis: newer owner messages are not cleared by older startup completion.

Turn transitions serialize per group; queue/budget writes have a separate lock so posting does not await slow admission. Both lock bodies are uninterruptible, unlike waiting to obtain the permit (`apps/server/src/group-chats/group-chat-context.ts:89–93`). Stop clears pending and aborts active executions (`apps/server/src/group-chats/group-chat-members.ts:54–73`). Restart revisits persisted pending members after bot recovery (`apps/server/src/group-chats/group-chat-service.ts:222–237`; `apps/server/src/app/tenant.ts:348–351`). Cursor recovery has the terminal-marker gap in F07.

Executed tests at `apps/server/src/group-chats/group-chats.test.ts:295` ("messages accepted during startup get one follow-up and retries add none") assert exactly two model inputs and exclude the first message from the follow-up; `:391` asserts coalescing two pending messages into one follow-up; `:439` asserts stop publishes nothing and starts no additional Ada input; `:949` verifies pending startup survives reopen. These are substantive assertions, not just status checks.

<a id="group-r07"></a>

#### R07 — Group turn publication and settlement — P1 (F07)

`GroupTurn.status` is `running | posting | settled`, independently of execution status (`apps/server/src/group-chats/group-chat-repository.ts:31–40`). Dispatch reuses the conversation/request execution, recovers an execution created before send throws, records the turn, consumes the captured pending generation, and explicitly finishes an execution that already ended (`apps/server/src/group-chats/group-turn-engine.ts:253–304`). An asynchronous settlement callback is forked into the group scope and then takes the group lock (`:453–459`, `:543–562`); it cannot concurrently publish the same group turn with another lock holder.

Finish marks posting, suppresses publication for a missing group/member, publishes only successful executions, and settles before updating the member cursor (`:419–450`). Message/reaction writes use `groupPostRequest(executionId)` (`:348–410`), so a posting retry cannot duplicate the durable entry. Passes create no visible post; failed/cancelled executions do not advance the cursor. Publication failure leaves posting, but there is no periodic retry here: restart scans running/posting and retries terminal executions (`apps/server/src/group-chats/group-chat-service.ts:222–237`). Normal scope cancellation cannot interrupt a held group lock; process death can, producing F07.

Executed `apps/server/src/group-chats/group-chats.test.ts:973` asserts one answer after reopening interrupted work. At `:993`, "an unfinished post is completed once" manually restores an already-published turn to posting and asserts one transcript message plus final settled status. It proves idempotent replay, but does not cover the opposite crash boundary, settled-before-cursor. `apps/server/src/group-chats/group-turns.test.ts:294` asserts message/reaction/pass outcomes.

<a id="group-r08"></a>

#### R08 — Bot-turn budget and answer notification — P2 (F28)

The group row persists `botTurns`, `paused`, and serialized `awaitingAnswers` (`apps/server/src/group-chats/schema.ts:10–17`). Bot-started wakeups stop when paused; charging atomically under the queue lock admits the eighth turn and pauses further bot-started turns (`apps/server/src/group-chats/group-turn-engine.ts:104–121`, `:181–187`, `:229–230`). Owner-created posts reset the count/pause and track enabled addressed members, retaining up to 50 outstanding owner entries (`:461–484`, `:507–515`). Queued owner work wins over bot-started work, so pausing does not intentionally discard an owner request. The queue lock serializes charging and owner resets; I found no basis for inventing an interleaving between synchronous field assignments.

A text answer consumes entries it actually saw and was eligible to answer, then announces using the execution as event identity (`:124–168`). Removing the entire owner-entry tracking record makes this a first-answer notification, not one notification per bot; reactions and passes do not consume it. Awaiting-answer consumption and the downstream announcement are not one durable transaction; a hard crash between them can lose the notification, not its transcript answer. This is a residual notification window, not a claim to have audited push delivery.

Executed tests `apps/server/src/group-chats/group-chats.test.ts:417`, `:536`, `:564`, `:584`, `:608`, and `:645` assert the exact eight-turn cap, first textual-answer notification, suppression of a second answer, overlapping owner-message notifications, retry suppression, and no notification for subsequent bot exchanges. F28 undermines retry suppression when `created` is incorrectly true; those tests do not control the clock.

<a id="group-r09"></a>

#### R09 — Late-member summary gate — P1 (F17)

A first turn after joining with `cursor > 0` and `summary === null` queues work and starts a background summary (`apps/server/src/group-chats/group-turn-engine.ts:218–226`). Membership update captures the latest transcript entry as the new member's cursor (`apps/server/src/group-chats/group-chat-service.ts:35–43`). A transient set suppresses duplicate in-flight summaries by only `groupId:agentId`; completion takes the group lock, checks only whether a member currently exists, stores the summary, and wakes pending work (`apps/server/src/group-chats/group-turn-engine.ts:307–344`). Model failure/empty output becomes a persisted fallback (`apps/server/src/group-chats/group-turn-input.ts:24–83`). Removing a member suppresses completion only while it remains absent: remove/rejoin during the same summary defeats that check, as reproduced in F17.

The background job does not hold the group lock during model inference, so stop/removal remains responsive. Stop clears pending but does not abort inference; a later completion may save a summary without waking work. Restart loses the set and can retry persisted summary-required pending members. No membership incarnation or captured-cursor validation protects completion, so a stale summary, once stored, survives restart and bypasses the null-summary gate.

Executed `apps/server/src/group-chats/group-chats.test.ts:676` asserts one summary, correct prefix, exclusion of old messages from new input, and no second prefix; `:700` covers a completed-turn leave/rejoin, not an in-flight summary; `:725` proves stop is responsive and creates no Hopper execution; `:775` asserts fallback still reaches the bot. The additional gated reproduction shows the missing incarnation case.

<a id="group-r10"></a>

#### R10 — Group transcript write receipt — P2 (F28)

`GroupTranscripts.write` submits a durable display-only write with request identity, waits for done, reads the committed entry, and compares text, sender kind/ID, reply target, reaction and attachment digest before returning the receipt (`apps/server/src/group-chats/group-transcripts.ts:33–43`, `:74–118`). That comparison correctly rejects changed payloads rather than trusting Pi's request deduplication. The installed dependency admits one submission per conversation/request on its commit line and returns a known submission without writing (`apps/server/node_modules/@earendil-works/pi-durable/dist/harness/submissions.js:35–48`, `:138–168`). Waiting registers/checks on that same line (`:68–82`), so there is no lost completion event.

The durable entry and request survive reopening; the caller's transient `created` flag is inferred from timestamp equality (`apps/server/src/group-chats/group-transcripts.ts:115–117`). Equal milliseconds do not establish which invocation inserted the entry: the real implementation repro in F28 returns true twice while storing one entry. Owner scheduling trusts this bit (`apps/server/src/group-chats/group-chat-post.ts:94–119`), creating a plausible budget/notification failure rather than duplicate transcript entries.

Executed `apps/server/src/group-chats/group-transcripts.test.ts:76` asserts duplicate calls return the same entry, retain one message, and reject different text; it calls `post`, which discards `created`, so does not test that contract. `:94` verifies reopen persistence/deletion. No exact-once guarantee for post-write scheduling is claimed: retry can repair a missing queue after a write-before-queue crash.

<a id="group-r11"></a>

#### R11 — Delegation reservation and composite result — OK within inspected scope

A durable request row fixes source, target, normalized recipient, and message before asynchronous chat admission (`apps/server/src/bot-messaging/bot-messaging.ts:348–384`, `:415–452`; `apps/server/src/bot-messaging/schema.ts:14–20`). Replays retain the original target across renaming and reject changed messages/destinations. Receipt insertion is idempotent and follows execution creation (`apps/server/src/bot-messaging/delegation-store.ts:31–38`). A crash between those steps requires replay of the safe tool to finish host bookkeeping; the reservation and execution request identity make replay repairable, but there is no separate receipt-repair sweep.

Permissions, non-self/enabled target, recursion, and four-active-task capacity are checked again after chat opening (`apps/server/src/bot-messaging/bot-messaging.ts:149–159`, `:189–209`, `:434–451`). Rejected hypothesis: two ordinary simultaneous opposing asks necessarily form a cycle. The last checks through synchronous execution insertion have no asynchronous input-validation work (empty attachments), and the executed opposing-asks test admits exactly one. I did not treat each Effect yield as a JavaScript scheduling point.

Results are source-scoped and reauthorize after waits; only completed selected turns/reports are exposed. Open job work overrides execution completion, and job errors override successful completion (`:83–92`, `:272–344`, `:461–511`). Wait cancellation/timeout does not abort the delegated execution. Terminal transcript cards use deterministic per-status IDs.

Executed `apps/server/src/bot-messaging/bot-messaging.test.ts:135`, `:167`, `:192`, `:221`, `:326`, `:366` assert deduplication, rename stability, cross-target conflict, scoped/revoked receipts, waiter-only cancellation, and cycle prevention. Integration tests at `apps/server/src/bot-messaging/bot-messaging-integration.test.ts:25` assert private memory is not leaked and closing cards persist/deduplicate; `:443` asserts running/no response while jobs remain open and the final report answer afterward.

<a id="group-r12"></a>

#### R12 — Reporter-first job question routing — OK within inspected scope

Job-question publication invokes the registered listener after the owner-visible card is written (`apps/server/src/jobs/jobs.ts:775–787`); production wiring calls `relayQuestion` and logs failures (`apps/server/src/app/job-wiring.ts:48–69`). Routing resolves originating submission IDs into a delegation execution and source-scoped receipt, rechecks reporter permission/assignee enablement, persists question route, then submits a reporter-chat input under `jobQuestionRequest(assignee, question)` (`apps/server/src/bot-messaging/bot-messaging.ts:513–560`). Invalid/no-delegation cases leave the owner as answerer. The route persists; the reporter input is deduplicated on replay. A reporter task re-entered in its report phase repeats listeners after restart (`apps/server/src/jobs/jobs.ts:783–786`), but completed reporter tasks are not a general relay-retry queue.

Answering rechecks source ownership and current permission before calling the assignee's real job API (`apps/server/src/bot-messaging/bot-messaging.ts:562–590`; `apps/server/src/bots/bots-submissions.ts:143–151`). The decisive compare-and-clear plus delivery queueing occurs in one durable `harness.commit`, checking the exact question ID (`apps/server/src/jobs/jobs.ts:1526–1559`). Thus owner and reporter cannot both answer the old question; stale persisted routes do not bypass that guard. The reporter answer tool is intentionally replay-unsafe (`apps/server/src/bot-messaging/coordination.ts:132–163`).

Executed `apps/server/src/bot-messaging/bot-messaging-integration.test.ts:480` verifies reporter-origin input, owner-visible question, reporter answer actually resuming the job, rejection of a later owner answer, and one question execution. `:531` verifies revoked reporter permission leaves the owner able to resume it. The reverse winner race and process-kill relay windows were statically traced, not independently executed. I did not promote a hypothesized very-fast-question-before-receipt race without establishing the actual runtime scheduling needed to reach it.

### Numbered local findings

<a id="finding-f17"></a>

#### F17 — P1, high confidence, R09: an old summary is installed into a new membership

**Evidence / outcome:** Reproduced with the real group implementation. The in-flight key is only group/bot identity (`apps/server/src/group-chats/group-turn-engine.ts:314–316`), and completion checks only present membership, then stores unconditionally (`:327–336`). Repository update deletes removed membership rows and inserts fresh rows for rejoining members (`apps/server/src/group-chats/group-chat-repository.ts:198–233`). The service sets the rejoined member's cursor to current transcript latest (`apps/server/src/group-chats/group-chat-service.ts:35–43`). No captured `joinedAt`, cursor, or membership generation is compared.

**Minimal trigger:** (1) Post initial history with two members. (2) Add Hopper, post an addressed message and hold its summary model completion. (3) Remove Hopper while inference is held. (4) Add a new important group fact. (5) Re-add Hopper, and post a new addressed question. (6) Release the original summary. The new summary attempt is suppressed by the old key, and the old completion writes to the new membership and wakes it.

**Violated invariant:** The first turn's summary must represent history up to this membership's joining cursor. Actual input contains the earlier summary and only messages after the new cursor; intervening facts are omitted from both. This is not arbitrary DB corruption or JS interleaving: the model promise explicitly releases the group lock for normal public membership operations.

**Executed command/result:** `bun /tmp/crumble-state-review-d5de813/repro-r09.ts` printed:
```json
{"summaries":1,"hopperInputs":["Summary of the conversation before you joined:\n\nOLD SUMMARY BEFORE REJOIN\n\nGroup chat \"Trip\". You are Hopper; the other members are the owner and Ada, Grace.\n\nNew messages:\n\nOwner: @Hopper rejoining question"],"missingNewFact":true}
```
The faux model is deliberately deterministic; the defect is stale summary ownership, not the model's ability to summarize.

**Public reachability / impact:** The normal update and post API paths call these operations (`apps/server/src/group-chats/group-chats-api.ts:24–35`, `:61–68`). Requires leave/rejoin during a potentially 60-second summary, not special privileges beyond owning the group. Affects that member's working context, potentially causing wrong decisions or missed requirements. It does not delete the shared transcript or leak cross-account data. Low-frequency but meaningful correctness bug. Stored stale summary and advanced joining cursor survive restart; ordinary retry does not regenerate because summary is non-null.

**Test gap / repair boundary:** Existing completed-summary rejoin test at `apps/server/src/group-chats/group-chats.test.ts:700` misses in-flight replacement. Add the exact gated sequence above at the existing faux summary seam, asserting that the rejoined first input includes the intervening fact and that an obsolete completion cannot populate the new membership. Associate inference ownership with a membership incarnation plus captured cursor; reject obsolete completion and allow/wake the new incarnation's summary. A group/bot-only set is insufficient. No general FSM framework is necessary.

<a id="finding-f28"></a>

#### F28 — P2, high confidence in receipt defect; production scheduling impact unverified, R08/R10: millisecond equality misclassifies duplicate writes as new

**Evidence:** `apps/server/src/group-chats/group-transcripts.ts:83–87` stamps each attempted write with `Date.now()`, and `:115–117` sets `created` by comparing committed and attempted timestamps. Pi deduplicates by request, not timestamp (`apps/server/node_modules/@earendil-works/pi-durable/dist/harness/submissions.js:150–156`). A different call can have the same timestamp. The caller uses created to reset budget, unpause, replace awaiting-answer tracking, and requeue members (`apps/server/src/group-chats/group-turn-engine.ts:461–515`; `apps/server/src/group-chats/group-chat-post.ts:94–119`).

**Minimal trigger:** Two same-group/same-request/same-content invocations observe the same clock millisecond. The second returns the first entry but `created: true`. Such equality can occur with fast/concurrent duplicates, reduced timer resolution, or a wall-clock correction; the repro controls the clock rather than claiming a naturally observed deployment incident. A meaningful budget/notification effect additionally requires progress between the two queue applications: the second can reset a nonzero count or restore consumed answer tracking. That downstream schedule was not reproduced, hence P2 rather than P1.

**Executed command/result:** `bun /tmp/crumble-state-review-d5de813/repro-r10.ts`, freezing `Date.now` while calling the actual implementation twice, printed:
```json
{"first":{"entry":7,"entryId":"00000000-0000-4000-8000-000000000001:7","created":true},"replay":{"entry":7,"entryId":"00000000-0000-4000-8000-000000000001:7","created":true},"entries":1}
```

**Invariant / reachability / consequences:** One durable insertion should produce at most one new-write receipt. The public group-post route accepts reusable owner request IDs, so duplicate invocation is supported, not invalid usage (`apps/server/src/group-chats/group-chats-api.ts:61–68`). Transcript integrity remains intact. Exposure is narrow; no demonstrated unbounded execution or externally exploitable budget bypass is claimed. A later retry with a different timestamp correctly returns false, but cannot undo already reset progress; a reopen loses no entry and retains progress changes already committed.

**Test gap / deterministic proposal:** `apps/server/src/group-chats/group-transcripts.test.ts:76` only checks the entry identity/count through `post()`, hiding `created`. At the real `write()` seam, hold a fake clock constant and assert first true, duplicate false, one committed entry. For downstream proof, use the real group fixture, gate first startup/model work, replay under the same clock and observe that an already charged budget/consumed answer record is not reset. Use committed insertion ownership (for example a unique per-invocation nonce retained in the entry, rather than a timestamp) or a runtime-provided insertion receipt. No process-local-only seen-request map would fix restart semantics.

<a id="finding-f07"></a>

#### F07 — P1, high confidence, reproduced SQL-failure boundary; kill variant not executed, R06/R07: settled is persisted before the success cursor checkpoint

**Evidence:** `apps/server/src/group-chats/group-turn-engine.ts:443–448` writes turn settled, then separately writes successful member cursor. These use separate repository statements (`apps/server/src/group-chats/group-chat-repository.ts:280–303`, `:368–376`), not a common transaction. Recovery enumerates only running/posting (`apps/server/src/group-chats/group-chat-service.ts:222–237`), and both `finish` and settlement callback return immediately for settled (`apps/server/src/group-chats/group-turn-engine.ts:424`, `:456`). A keyed semaphore/uninterruptible Effect region is not a database transaction or protection against process death.

**Minimal trigger / expected versus actual:** Have a successful public group turn with `through > member.cursor`. Let its answer publish and its settled update commit, then fail the following cursor update (or terminate the process before that update). The visible answer exists and the turn is settled, but the cursor remains behind. With no pending follow-up, recovery skips the turn entirely. A later owner post starts a different request through a later entry and incorporates the already-answered old owner messages in its unseen input (`apps/server/src/group-chats/group-turn-engine.ts:94–101`, `:212–216`, `:253`). Expected: successful settled turns checkpoint consumption through their input, or recovery completes that checkpoint. Actual stale-cursor and next-input outcome were reproduced by failing the SQL statement, not by manually corrupting saved progress.

**Executed failure experiment:** `bun /tmp/crumble-state-review-d5de813/repro-r07.ts` installed a throwaway SQLite trigger only in its temporary database: fail an update iff `NEW.cursor > OLD.cursor`. It posted through the real group service, observed the expected `Settled execution handler failed` query error, removed the fault, invoked real `groups.recover()`, and posted again. Output established `before.cursor = 0`, `afterRecovery.cursor = 0`, first turn `through = 7, status = settled`, and two executions with distinct request suffixes `:7` and `:11` **in the same private conversation**. The first model input contained `Owner: @Ada ORIGINAL INSTRUCTION`; the second contained both that same old instruction and `Owner: @Ada NEW INSTRUCTION`, with `oldInstructionRepeated: true`. Thus private conversation history does not prevent re-admission: the new through-bound request really submits another model input containing the old message. This is not proof the model performs a side effect twice; it is proof the consumed instruction is re-presented as new, with a repeat-action risk. SQL fault injection simulates checkpoint-write failure; production would require an actual SQL/IO failure or hard process crash at this boundary.

**Reachability / severity / restart:** This boundary is on ordinary post → execute → publish. Neither the group lock nor the caller supplies a transaction around both repository operations. SQL failure is logged by the forked settlement handler, with no compensating cursor write or reversion to posting. Normal scope interruption is different: lock bodies are explicitly uninterruptible (`apps/server/src/group-chats/group-chat-context.ts:89–93`). No arbitrary persisted-state corruption is required. Rare, per-member/per-group impact is repeated owner instructions and incorrect consumption semantics, not duplicate publication of the original execution. Restart/recovery cannot repair it because settled turns are excluded. A newer successful turn eventually advances the cursor only after being given the stale instructions. Classified P1 for this reproduced meaningful progress bug; practical failure frequency and repeat-side-effect behavior are not asserted.

**Test gap / deterministic proposal:** `apps/server/src/group-chats/group-chats.test.ts:993` tests posting replay, the other side of this boundary. Turn the executed temporary SQL-fault reproduction into a hermetic test, asserting recovery advances the cursor through the old input and that the second real runtime input excludes it. A second proposed test can use a child process and repository wrapper to signal immediately after the settled update commits, block, kill, reopen and run recovery. The kill variant was not executed. The justified shared boundary is a repository transaction that commits successful cursor advancement and terminal turn state together (or an explicitly recoverable cursor-checkpoint phase); no need to redesign unrelated lifecycle state.

### Limits and rejected hypotheses

- No bot-admission, job-delivery, auth, frontend, push-transport, or account-lifecycle audit was duplicated. Those paths were read only to establish group/delegation boundary semantics.
- Installed Pi Durable was inspected at the submission/commit/wait and caller boundary; this was not a general dependency audit. Bun SQL's synchronous statement execution and semaphore-backed connection acquisition were checked in `apps/server/node_modules/@effect/sql-sqlite-bun/src/SqliteClient.ts:222–304`; absent an actual suspension/transaction contender, I did not infer lost updates merely from multiple Effect yields or repository read/modify/write shape.
- Existing tests cover normal scoped shutdown, not arbitrary process kills. F07's SQL-failure path and next-wake behavior were executed; its hard-kill variant remains unexecuted. None of the reproductions is a mutation test.
- Receipt-before-fast-question admission, reporter/owner reverse winner order, delayed permission changes during reporter chat opening, and exact post-publication notification crash windows did not receive independent reproductions. Existing permission/answer guards and fallback paths were traced; no additional confirmed finding is claimed.
- A stalled summary finishing after stop is not by itself a bug: stop clears pending, so completion can store without starting work. Missing-member completion is guarded; only membership replacement defeats that guard (F17).
- Idempotent group write comparison intentionally ignores display-only metadata such as current bot name/source decoration; this was not treated as arbitrary changed-content corruption without an actual caller changing authoritative payload.

<a id="auth-flows-review"></a>

## Provider and integration authorization

### Scope and evidence

Reviewed exactly **R16–R20, I08–I11, J23 (10 groups)** from `docs/implicit-state-machines.md`. Read the review brief, repository instructions, and `GLOSSARY.md`. The checkout is `95570dd0519ca22b8a3361b26af8e23c59f687a0`, not `d5de813`; `git diff d5de813 -- apps/server/src/providers apps/server/src/integrations apps/server/src/github-apps apps/server/src/secrets/server-secrets.ts` is empty, so the reviewed production sources match the requested commit. Inventory is untracked and was not changed. No repository edits or mutations were made. Read Effect's installed `AGENTS.md` completely before creating the Effect-using reproduction.

**Results:** three P1 findings (two authorization resurrection bugs and one connection-resource leak); one P2 finding (manifest conversion recovery). Group classifications: P1=3, P2=1, OK=6; P0/P3=0. Findings are separate from test-coverage limitations.

#### Executed checks

- `bun test apps/server/src/providers/provider-auth.test.ts apps/server/src/providers/provider-credentials.test.ts apps/server/src/providers/claude-code/claude-code-adapter.test.ts apps/server/src/providers/claude-code/claude-code-plugin.test.ts apps/server/src/providers/claude-code/claude-code-relay.test.ts apps/server/src/integrations/integrations.test.ts apps/server/src/integrations/mcp-oauth.test.ts`
- Result: **193 pass, 0 fail, 1179 assertions, 7 files, 2.06 seconds**. Full output: `/tmp/crumble-state-review-d5de813/auth-tests.log`.
- `bun /tmp/crumble-state-review-d5de813/auth-repro.ts`: imports unmodified production MCP functions and existing integration test harness. Uses a loopback OAuth fixture, a map implementing the actual `SecretStorage` seam, and separately a real temporary product store with injected MCP clients. Output:
  ```text
  MCP auth immediately after signOut: false
  MCP auth after older completion returns: true
  MCP concurrent opens created: 2 closed after scope disposal: [2]
  ```
- `bun /tmp/crumble-state-review-d5de813/github-repro.ts`: real `GitHubAppUsers` layer and temporary encrypted SQLite store; intercepts fetch exclusively for the two GitHub endpoints, with no real network/credentials. Output:
  ```text
  GitHub owner after signOut: undefined
  GitHub owner after older refresh: { login: "owner", userId: 3 }
  ```
  Captured output is in `auth-repro.log` and `github-repro.log` beside this report. These exercise actual implementations, not reimplemented machines. Remote GitHub revocation validity is not simulated beyond returning a successful response.

### Per-group analysis

<a id="group-r16"></a>

#### R16 — Interactive provider sign-in — OK

`apps/server/src/providers/provider-auth.ts:62–78` represents a session with status, prompt/resolver, abort controller, timing, events, and failure. `start:160–177` reserves one active session per provider before launching authentication. Prompt settlement clears the prompt synchronously (`:408–444`); duplicate or old prompt IDs cannot advance it (`:275–304`). Cancellation, replacement and sign-out invalidate the active session (`:195–210`, `:472–509`). The significant invariant is **only a still-current pending session may commit credentials**: `save:372–390` delegates its guard to the serialized store, and `isCurrent:462–469` includes identity, cancellation, and both deadlines. Guard/write/success are synchronous once admitted to that queue, so a proposed cancellation between guard and commit is not a valid JavaScript interleaving.

An uncooperative login promise is raced with abort; the flow wrapper settles on cancellation, and late results cannot commit. Close cancels active sessions, waits wrapped flows and drains credential queues (`:221–227`). Sessions/prompts are transient; restart drops them while credentials survive. Ended sessions are bounded/pruned (`:530–545`). Existing executed tests at `provider-auth.test.ts:72–102`, including “recognizes the system's address-in-use error” and “reports other failures as provider failures”, assert sanitized failure classification, not prompt/cancel/queued-commit safety. Those latter properties are statically traced, not dynamically covered by these tests. Multi-row credential persistence limitations belong to R17.

<a id="group-r17"></a>

#### R17 — Serialized provider credential mutation — OK

`apps/server/src/providers/provider-credentials.ts:123–226` has one promise tail per provider. Modify/refresh reads stored metadata only after entering the queue, calls the updater, and writes its result before releasing the tail. Delete, completed login and API-key replacement enter the same queue. A rejected task cannot poison subsequent operations because the stored tail catches rejection (`:206–210`); identity checking prevents an older tail deleting a newer queue entry. Cancellation before execution rejects/skips work; after `started=true`, the signal deliberately does not detach the caller or discard the rotated token (`:198–224`). Thus a refresh cannot overwrite a later sign-out: sign-out waits behind it, unlike I11.

Login's guard, synchronous secret/repository write and committed callback share one queue turn (`:161–174`). API-key-reference validation may await, but it still holds queue ownership (`:176–183`). Reads are not serialized; they are observations rather than mutation claims. Credentials and secret values are durable/encrypted (`provider-credential-repository.ts:47–83`); queue state is transient. Shutdown's sign-in finalizer drains tails. Separate secret/metadata writes (`:58–73`) are not a crash-atomic transaction: disk/process failure can leave an intermediate combination, and no startup reconciliation was found. That limitation does not establish a normal cancel race. Executed tests `provider-credentials.test.ts:59,67,75,91`, including “an API key from a password manager reaches the model's auth” and “a key's reference is read when saved, and replacing or deleting it changes what the model gets”, assert resolved model auth, contextual read errors, reference replacement, and deletion; no direct queue-order/cancellation/failure-tail test was found.

<a id="group-r18"></a>

#### R18 — Claude Code replay, stream, process lifetime — OK

The real protocol is broader than CLI result status: replay user frames carry `shouldQuery:false`, and each waits for a zero-turn, nonerror result before subsequent history/query input (`apps/server/src/providers/claude-code/adapter.ts:720–771`). A queued line parser bounds waits (`:447–505`); incremental text/thinking is distinct from authoritative captured content (`:774–891`). Final acceptance requires an admitted HTTP 200, completed capture, no dropped malformed tool inputs, exactly one native result, and an allowed result/exit combination (`:965–1063`). Tools are emitted only after validation. Fast completion additionally requires native message-stop, no error and zero denied retries (`:1451–1469`). A successful fast result transfers ownership to a ten-second process drain; other outcomes synchronously release child/admission, and abort kills the detached process group (`:1266–1277`, `:1396–1480`). These resources are transient; there is no replay of a half-finished process after restart.

Executed `claude-code-adapter.test.ts:289`, “replays earlier turns in order, one acknowledged frame at a time”, checks acknowledged replay's actual upstream history; `:353` checks one upstream request and retained first length-limited answer; `:369/:385` check truncated/broken tool arguments release no calls, `:448` checks refusal, and `:534` checks abort kills recorded process IDs. The tests use a fake CLI with real adapter/relay, not installed Claude. Fast-drain late-exit permutations and orphaned descendants after an already-exited leader were not established against the real CLI; no finding is inferred from those possibilities.

<a id="group-r19"></a>

#### R19 — Single-use model admission and response capture — OK

`apps/server/src/providers/claude-code/relay.ts:188–218` validates route/method/Origin, then consumes `used` **before its first await**. Concurrent native requests cannot both pass; forwarding failure also consumes admission. `abort/close:172–181` ends upstream/listener ownership. Capture parses SSE boundaries across chunks, indexes blocks, accumulates tool JSON and only marks complete with a stop reason and no unfinished argument buffers (`relay-capture.ts:102–226`). Bad completed JSON is dropped, and R18 then rejects the entire tool-bearing answer rather than executing guessed inputs. Unknown provider event types are ignored; arbitrary corrupt event ordering is not assumed reachable.

Forwarding uses one upstream attempt except explicitly recognized compressed-body rejections (`relay.ts:221–265`). `relay-gzip.ts:22–31,85–154` holds a process-wide fallback and disables compression for proxies/custom certificates; fallback restarts after process restart. This is not general retry of model generation. Stream reads have a byte-idle timeout and abort on pipe failure (`relay.ts:283–335`); there is no durable admission to resume after crash. Executed `claude-code-relay.test.ts:2371`, “forwards exactly one request and denies the rest”, asserts the second request is denied and only one upstream body arrived; `:2394` asserts exact captured text/tool args/usage; `:2472` preserves error diagnostics; `:2299` drops cut-off tool JSON. Gzip-refusal and upstream-stall cases have no dedicated assertions in this suite and were only statically inspected.

<a id="group-r20"></a>

#### R20 — Claude status refresh cache — OK

`apps/server/src/providers/claude-code/plugin.ts:112–123` stores `{at,status: Promise}`. Initial callers share the same observation; subsequent calls reuse it for 30 seconds, then replace the observation. Invalidation clears the reference, not an old promise's result. An old completion cannot repopulate the cache because there is no completion-side assignment. Rejected-promise poisoning was considered: `setup.ts:223–275` converts missing executable, version failure and sign-in probe failure into status values, and TTL replacement independently permits recovery. At most one probe is coalesced inside its TTL; a probe lasting beyond TTL may overlap a newer probe, but observations do not own/rotate credentials.

Consumers include provider `check` and external-auth display (`plugin.ts:129–156`) and adapter command admission. Native auth failure or upstream 401 explicitly invalidates status (`adapter.ts:941–948,978`), so repeated requests need not wait the full TTL after observed rejection. External CLI sign-in/out remains eventually observed, not instantly pushed. Everything here is transient and reconstructed after restart; CLI configuration remains the durable authority. Executed `claude-code-plugin.test.ts:131,156,172,259,284,300`, including “reports signed in with the plan” (`:172`) and “is configured once Claude Code is signed in” (`:284`), asserts missing/signed-out/signed-in projection and refusal to delete external credentials. These are substantive status/API assertions, but do **not** assert TTL, concurrent coalescing or invalidation; those cache transitions were statically reviewed.

<a id="group-i08"></a>

#### I08 — MCP live connection cache — P1 (F21)

`apps/server/src/integrations/integrations.ts:187–200,234–285` encodes failures, disconnect generations and cached connection fingerprints. Fingerprints include URL, bearer headers and OAuth mode. Changing these closes a cached connection; explicit disconnect increments generation and removes ownership (`:430–442`). Late opens after disconnect/close are rejected and closed, including the token-read-before-open window. However, generations do not distinguish **two simultaneous opens within the same generation**. Both pass the absent-cache check, await connect, and unconditionally publish; one resource is overwritten and becomes unreachable by cleanup. This is reproduced in F21.

Tool execution checks current enabled/owner permissions before acquiring a connection and once more before invoking the remote tool (`:321–352`); mutation tools have unsafe replay and are not retried. Timeout/caller interruption propagates; listings that fail evict and close (`:288–315`). Scope shutdown only closes resources still in the map (`:444–456`), which exposes F21. No durable connections exist; restart reconstructs from saved server/authorization state. Executed `integrations.test.ts:289`, “bounds a client that ignores timeoutMs”, and `:337/:391` assert timeout and cancellation behavior; `:515`, “a failed listing closes the transport with the client”, asserts both resources close; and `:606`, “a disconnect during a token read leaves no connection open”, explicitly gates token read across disconnect and asserts the stale resource closes and later retries reconnect. None covers simultaneous shared-server discovery, though separate bots can invoke the public extension source concurrently.

<a id="group-i09"></a>

#### I09 — MCP OAuth sign-in — P1 (F02)

Encrypted `SavedOAuth` contains redirect, client identity, and dependency-owned registration/tokens/verifier/state (`apps/server/src/integrations/mcp-oauth.ts:23–27,161–170`). Start resets registration if server/client/redirect changed (`:254–275`), then invokes real dependency authorization. Finish checks the saved state, exchanges the code, and strips state/verifier (`:323–368`); sign-out deletes the entire record (`:149–151`). Changed client settings and API sign-out delete authorization and disconnect (`mcp-servers.ts:179–204,245–255`). The invariant breaks because an already-running finish can later save fresh tokens after that deletion: there is no attempt-generation fence or shared serialization around the storage writer. F02 reproduces it through the real OAuth implementation.

Dependency inspection rejects a different hypothesis: changing a URL does **not** blindly send the old OAuth bearer to the new URL; installed pi-mcp's `dist/oauth/provider.js:own()` ignores state whose `serverUrl` differs. Its write queue and refresh coalescing are per provider instance, not a server-wide invalidation fence. Live transport disconnect therefore does not cancel the separately running finish request. Persisted state survives restart, including any resurrected token. Executed `mcp-oauth.test.ts:175`, “signs in with a registered client, PKCE, and a checked state”, checks PKCE, mismatched/reused state and explicit sign-out; `:210`, “checks the issuer a server returns with the code (RFC 9207)”, checks issuer mismatch; `:259` checks reauthorization error; `:278` checks OAuth wins over a stored bearer. All sign-out assertions are sequential and miss an in-flight exchange.

<a id="group-i10"></a>

#### I10 — GitHub App setup and installation token cache — P2 (F25)

`apps/server/src/github-apps/github-apps.ts:294–324` writes encrypted hour-lived manifest state. Completion validates it, converts a manifest code, fetches the bot user's identity, drops pending state and finally persists the encrypted App/private key (`:326–386`). That second network step creates a concrete recovery window: converted secret material is only local memory until after `/users/...` succeeds. F25 records the plausible unrecoverable consequence if the conversion code is single-use. This external retry premise was not tested against GitHub, hence P2 rather than a confirmed production-loss claim.

Connect finds the owner's installation, persists installation identity, invalidates the token cache and synchronizes assigned bots' credentials (`:389–424`). Installation tokens are transient and renewed with a five-minute margin (`:532–552`); unlike rotating owner refresh tokens, parallel minting need not serialize because each minted installation token can coexist. App rows, assignment rows and private keys persist; cache loss on restart simply remints. Removal signs the owner out, deletes local App data, drops cached tokens and synchronizes credential grants (`:497–517`), explicitly leaving the remote App intact. Assignment mutations themselves use a transaction (`:464–489`); subsequent credential synchronization is a separate side effect. No App setup/connect/cache tests were found (only unrelated `ssh-signing.test.ts` in this directory). Recovery fault injection is proposed in F25, not executed.

<a id="group-i11"></a>

#### I11 — GitHub owner authorization and rotating tokens — P1 (F03)

`apps/server/src/github-apps/github-app-users.ts:152–182` creates ten-minute state plus PKCE verifier. Completion consumes pending state before exchange (`:184–233`), so ordinary sequential retry is refused; loss after exchange but before saving requires new sign-in. The encrypted access/refresh pair and both deadlines are saved together in one SQLite upsert (`:108–136`). Token selection reuses fresh access tokens and serializes refresh with a semaphore; refresh rereads storage after acquiring it (`:273–330`), correctly coalescing competing requests using a rotating refresh token.

But sign-out and completed login do not take that semaphore or invalidate its result. Sign-out reads the old row, attempts remote grant revocation with a bounded/ignored error, then deletes the row (`:235–262`). An older refresh can subsequently upsert the deleted owner and tokens. This is reproduced in F03. The public API does not serialize requests (`github-apps-api.ts:18–26,98–111`), and live credential requests independently invoke `users.token` (`github-apps.ts:579–581`). Restart preserves the resurrected row rather than correcting it. Whether the saved token still works remotely depends on GitHub revocation ordering; local signed-in resurrection and failure to use App fallback are proven. No dedicated GitHub owner-auth tests were found; the executed provider-store serialization tests do not cover this separate implementation.

<a id="group-j23"></a>

#### J23 — Persisted pending authorization records — OK

`apps/server/src/secrets/server-secrets.ts:22–73` uses encrypted secret-record presence plus serialized `createdAt` and caller-provided schema/TTL. Put always generates its timestamp after spreading caller data (`:46–53`), preventing callers overriding creation time. Read decrypts, parses, validates and accepts age `<= ttlMs` (`:56–68`); the exact TTL boundary is valid, consistent with the “older than” contract. Drop removes the record (`:70–71`). These are storage operations, not an atomic consume primitive: OAuth callers choose when to drop, notably I11 before exchange and I10 after conversion/user lookup.

Pending records survive restart; expired records are ignored but not automatically pruned, so abandoning flows leaves encrypted rows. That is retention/maintenance rather than proof of an authorization bypass. JSON.parse can throw before schema validation, but only this module writes these keys with JSON.stringify; arbitrary malformed storage was rejected as a reachable bug premise. Wall-clock rollback can lengthen age-based validity, a general durable-TTL constraint rather than a demonstrated public exploit. No direct PendingStates test was found. Sequential MCP tests exercise a *different* OAuth state store and are not credited here. I10/I11 integration tests are also absent; TTL/read/drop correctness is therefore source-reviewed, not dynamically verified in this partition.

### Numbered findings

<a id="finding-f21"></a>

#### F21 — P1, high confidence — simultaneous MCP opens lose resource ownership (I08)

**Independent verification:** The default production HTTP transport was also exercised against a loopback fixture: two initialized SSE streams, one DELETE/cancellation on disposal, one stream still open. This proves retained resource ownership, not resource exhaustion.

**References:** `apps/server/src/integrations/integrations.ts:234–285` (check/open/publish), `:430–456` (disconnect/finalizer), `:454–457` (public extension entry point). Exact overwrite is `connections.set(server.id, cached)` at `:281`.

**Minimal sequence:** Two enabled bots share a server; its cache is absent. Both call `extensionsForAgent`. Pause both clients' `connect()` promises after factory construction. Both have already observed no existing connection and captured the same generation. Release both; both publish success, second overwrites first. Dispose the integration scope (or disconnect). Only the second closes. No unusual database state or runtime interleaving within a synchronous block is needed: the two awaited connect operations are the actual race boundary. Public extension calls create independent `Effect.runPromise` fibers, and different bots are not serialized by this module.

**Invariant/outcome:** Every acquired client/transport must remain owned until closed. Actual production-module reproduction creates two and closes only `[2]` on scope disposal; this is confirmed, not hypothetical. Repeated concurrent cold/reconfigured opens leak remote sessions, streams or transport resources for the account and may hit server connection limits. This is a meaningful server/resource bug with limited account-local blast radius, not a cross-account access exploit. Retry can accumulate leaks; process restart ultimately releases OS-owned resources, not necessarily immediate remote session state.

**Tests/proposal:** `integrations.test.ts:606` proves disconnect-generation fencing, not competing successful opens. Add a two-bot test at `IntegrationsOptions.clientFactory` using two deferred connect gates, then dispose and assert *both* client/transport pairs close exactly once (or assert single-flight creates only one). The executed `/tmp/crumble-state-review-d5de813/auth-repro.ts` is precisely that two-open scenario with real temporary persistence. A per-server opening promise/permit, or compare-and-publish that explicitly closes a losing open, is justified by resource ownership. A generic FSM framework is unnecessary. Eviction should also compare connection identity so an old failed listing cannot remove a newer cached owner.

<a id="finding-f02"></a>

#### F02 — P1, high confidence — MCP sign-out is undone by older OAuth completion (I09)

**Remediation implemented:** The [MCP OAuth invalidation design](designs/mcp-oauth-invalidation.md) fences persisted authorization with non-reused generations and checks the current server configuration. Client updates invalidate before mutation and after publication. Local gated OAuth and encrypted-store tests exercise delayed exchange, registration, successful and failed refresh, client updates, legacy records, and storage failures. Independent review found no meaningful issues.

**Verification:** `bun test apps/server/src/integrations/mcp-oauth.test.ts apps/server/src/integrations/mcp-servers.test.ts` passed all 20 tests with 64 assertions, independently rerun by the reviewer. Pre-fix runs demonstrated stale exchanges, registration, and client-secret lookup succeeding after sign-out, plus the client-update race; some compatibility and fault tests were added after the fix. `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check` passed with 1,080 tests passed, 118 skipped, and 0 failed. Two earlier final-check attempts stopped on test-spacing lint errors, corrected before this passing run. The documentation check passed. These tests do not prove crash durability, multi-process safety, or remote grant revocation.

**Evidence qualification:** The OAuth reproduction uses the real exchange and an in-memory storage seam. Durable storage/restart implications are source-proven, not a disk-reopen experiment. Sign-out does not revoke the remote grant.

**References:** `apps/server/src/integrations/mcp-oauth.ts:149–170` (unconditional delete/save), `:323–368` (state checked before awaited exchange), `apps/server/src/integrations/mcp-servers.ts:224–255` (independent finish/sign-out API operations), `:191–203` (client-change invalidation). Dependency boundary inspected: installed `@earendil-works/pi-mcp/dist/oauth/flow.js`, code-exchange branch awaits token response then `provider.saveTokens`; `provider.js` updates current storage without an invalidation generation.

**Minimal sequence:** Start valid sign-in and submit its matching callback. Hold the authorization server's `/token` response after the request reaches it. While finish is awaiting that response, explicitly sign out the same server. Authorization record is deleted and the API disconnects live connections. Release successful token response. The older finish writes tokens to the now-empty key and returns authorized. Sign-out requires only that the server exists; it does not reject a pending flow. These are independent public requests, not a guessed internal interleaving. Changing the client secret/ID can similarly invalidate while this exchange is outstanding.

**Invariant/outcome:** Explicit authorization invalidation must fence older attempts. Reproduced with the unmodified production module and actual pi-mcp exchange against a loopback fixture: `false` immediately after sign-out, then `true` after the old finish. New credentials survive process restart. Retry is unnecessary to trigger the bug; later discovery uses the restored authorization. This is an account-local sign-out/revocation-intent failure, not evidence of an unauthenticated/cross-account attacker. Likelihood requires overlapping browser/API activity, but the invalidation contract is security-sensitive.

**Tests/proposal:** `mcp-oauth.test.ts:175` only signs out after completion and proves sequential deletion. Add a gated token fixture to that actual storage/function seam (or `McpServers.finishSignIn/signOut` with the real store), await sign-out, release token response, and assert record remains absent and completion is rejected/stale. Extend to changed-client invalidation. `/tmp/crumble-state-review-d5de813/auth-repro.ts` executes the function-level test. Own an attempt epoch at the server authorization record and guard every delayed write; alternatively serialize authorization mutations with invalidation while ensuring sign-out wins. Live-connection generations alone do not protect storage.

<a id="finding-f03"></a>

#### F03 — P1, high confidence — GitHub owner refresh resurrects a signed-out owner (I11)

**Remediation implemented:** Owner refresh now updates only the captured authorization incarnation inside a transaction; it cannot insert a missing row. Sign-in admission/completion are fenced by persisted epoch and owner identity. Sign-out atomically rotates the epoch and deletes the local owner before best-effort remote revocation, with no late local deletion. Metadata uses existing encrypted secret storage without a schema migration.

**Verification:** Before production changes, `bun test apps/server/src/github-apps/github-app-users.test.ts apps/server/src/github-apps/github-apps.test.ts` had 17 failures and 2 passes. The routing regression returned the synthetic refreshed owner token instead of an installation token. After the fix, all 19 focused tests passed with 71 assertions, independently rerun by a fresh reviewer. An additional callback-admission case and revocation-token assertion bring the final focused run to 20 passing tests with 76 assertions. Coverage includes same-user replacement, delayed completion, pending-only invalidation, local-first revocation, legacy identity initialization, App removal, refresh serialization, malformed metadata, and transaction rollback under injected writes. These fixtures do not prove remote token validity or crash durability. Fresh review found no meaningful issues. `CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check` passed with 1,100 passed, 118 skipped, and 0 failed. Documentation checks passed, including strict link validation. Earlier root checks stopped on a test-fixture fetch type error and test-spacing lint error, both corrected before the passing run.

**References:** `apps/server/src/github-apps/github-app-users.ts:108–136` (unconditional upsert), `:235–262` (sign-out), `:273–330` (refresh-only semaphore and save), `apps/server/src/github-apps/github-apps.ts:579–581` (owner-vs-installation credential choice), `apps/server/src/github-apps/github-apps-api.ts:98–111` (public sign-out).

**Minimal sequence:** An App has an owner row with access token within the refresh margin, usable refresh deadline, and configured client secret. A bot credential request enters `users.token` and sends refresh. Hold its successful response. Concurrent owner sign-out completes grant-revocation attempt and deletes local row. Then release the refresh response. It unconditionally calls `save` using its pre-sign-out owner snapshot, whose insert/upsert recreates the row. The refresh semaphore only covers other refreshes; it cannot serialize sign-out. Public request runners impose no mutual exclusion.

**Invariant/outcome:** Once sign-out returns, earlier refreshes cannot restore signed-in state. Real-layer/encrypted-SQLite reproduction proves `users.of('app')` changes from `undefined` back to `{login:'owner',userId:3}`. Whether refreshed remote tokens remain valid after actual GitHub revocation is unverified and not needed to prove local failure: subsequent credential selection sees an owner and chooses owner token flow instead of installation-token fallback, possibly repeatedly returning revoked-token errors. If remote revocation was unreachable/failed (explicitly ignored), a still-valid rotated credential can also be restored. State persists across restart. Blast radius is bots assigned to that App in one account, with no demonstrated privilege escalation.

**Tests/proposal:** No dedicated tests for this service were found. At the real `GitHubAppUsers.layer` seam, intercept `fetch` for refresh and grant revocation, gate refresh response, sign out, release, then assert no owner row and installation fallback. `/tmp/crumble-state-review-d5de813/github-repro.ts` executed that service-level sequence (the fallback consequence is statically traced, not executed). Add refresh-vs-new-login and cancellation-after-rotation tests too. Use one credential-mutation serialization/epoch boundary covering refresh, login completion and sign-out, comparable to R17; refresh-only exclusion is insufficient.

<a id="finding-f25"></a>

#### F25 — P2, medium confidence, UNVERIFIED remote retry premise — converted GitHub App credentials can be discarded before persistence (I10)

**References:** `apps/server/src/github-apps/github-apps.ts:341–353` converts the code and then awaits `/users/<slug>[bot]`; `:355–383` does not persist private key/App/client secret until after that second network call. Conversion schema at `:69–80` includes the App's PEM and optional client secret.

**Minimal sequence/preconditions:** Valid manifest state/code. Conversion succeeds and returns new App/private-key material. The subsequent bot-user lookup fails (network, GitHub 5xx, or process crash), before any App row is written. Retry submits the same code. **Assumption requiring confirmation:** GitHub does not replay the conversion response for an already-consumed manifest code. If so, retry is rejected and the only returned private key/client secret was discarded; the owner must manually recover or recreate the remote App. No local startup recovery can reconstruct it. If GitHub replays the complete conversion result, the transient network-failure case is recoverable, so this remains P2 rather than a confirmed loss claim.

**Invariant/impact:** Once an external one-use operation yields durable identity/secret material, unrelated follow-up lookup failure should not erase the only recoverable result. Source proves the loss window; it does not prove GitHub's duplicate-conversion behavior. Normal public `completeGithubApp` directly invokes this flow. Severity is limited setup failure/orphan remote App, not loss of existing App authorizations. Similar crash windows between dropping pending state, inserting the App, and saving client secret are visible but were not fault-injected.

**Tests/proposal:** No setup tests exist. At the real `GitHubApps.complete`/`github()` fetch seam, return a conversion once, fail the bot-user GET, then reject duplicate conversion as a consumed-code fixture; assert the converted identity/PEM is recoverably staged before returning failure and retry resumes the lookup instead of reconverting. This experiment is **proposed, not executed**, and fixture behavior is not proof of GitHub behavior. Confirm the remote API contract separately. A durable converted-App staging boundary before additional network work is justified only if conversion is indeed one-use; no generic state-machine rewrite is proposed.

### Limits

No real provider/GitHub/MCP credentials or external services, installed Claude CLI, workspaces, emulators, or simulators were used. No controlled mutation was performed. Provider session prompt/expiry races, queue cancellation/failure-tail behavior, gzip fallback, status TTL, pending-state TTL, and GitHub setup fault recovery were statically traced but not newly executed. Existing tests run successfully do not establish those omitted assertions. Account authentication, secret-value caching, frontend redirect behavior, and gateways were excluded except necessary API/caller boundaries. Reports and throwaway scripts are exclusively under `/tmp/crumble-state-review-d5de813`.

<a id="delivery-review"></a>

## Automation, gateway, and push delivery

### Scope, baseline, and evidence

Assigned coverage: **I01–I07, I12–I13 (9/9 groups)**. Read the brief completely, the canonical `GLOSSARY.md`, applicable repository instructions, the inventory, production implementations, boundary wiring, and relevant tests. No repository file was edited. Reports, reproduction scripts, logs, and reproduction databases were confined to `/tmp/crumble-state-review-d5de813` (temporary reproduction databases were removed).

The working checkout is `95570dd`, not `d5de813`; `git diff d5de813 HEAD -- apps/server/src/automations apps/server/src/event-sources apps/server/src/message-gateway apps/server/src/push` was empty. The additional inspected `shared/ticker.ts`, `shared/database.ts`, `app/tenant.ts`, and test Store support also have no differences between these revisions. Thus cited implementation/test lines apply to the requested baseline. The pre-existing untracked inventory was left alone.

**Result:** 3 local findings, all **P1** (two reproduced at real implementation seams; one source-proven). Group classifications: I01 P1; I02 P1; I03 P1; I04 OK; I05 OK; I06 OK; I07 OK; I12 P1; I13 OK. A group can share a finding with another group; these are not five independent defects.

#### Executed verification

Command (from repository root):

```sh
bun test apps/server/src/automations/scheduler.test.ts apps/server/src/automations/event-dispatcher.test.ts apps/server/src/automations/event-runs.test.ts apps/server/src/automations/script-runs.test.ts apps/server/src/automations/script-run-repository.test.ts apps/server/src/event-sources/event-relay.test.ts apps/server/src/message-gateway/message-gateway.test.ts apps/server/src/message-gateway/gateway-repository.test.ts apps/server/src/message-gateway/discord/adapter.test.ts apps/server/src/push/push.test.ts apps/server/src/push/push-lifecycle.test.ts apps/server/src/push/push-transports.test.ts
```

**156 pass, 0 fail, 548 assertions, 12 files, 6.51 seconds**, exit 0. Full output: `delivery-tests.log` in this report directory. These are existing hermetic tests; no real credentials, remote services, emulator, or workspace service was started. Script-run tests execute local throwaway shell commands through their existing directory-backed environment.

Additional executed commands:

* `bun /tmp/crumble-state-review-d5de813/scheduler-edit-repro.ts` — exit 0; real Scheduler and Store, injected admission gate; proves finding F12. Output in `scheduler-edit-repro.log`.
* `bun /tmp/crumble-state-review-d5de813/push-ingestion-repro.ts` — exit 0 after correcting an initial local module-resolution error; real PushDelivery, Push, and SQLite PushRepository, injected one-shot enqueue defect; proves finding F13. Output in `push-ingestion-repro.log`. This replaces neither the consumer nor its queue logic.

No mutation experiments were performed. F06 was statically traced, not reproduced. Existing test success does not contradict the findings: their triggering transition sequences are absent from those tests.

### Per-group analysis

<a id="group-i01"></a>

#### I01 — Scheduled admission — **P1** (F12, F06)

Durable state is the schedule's `enabled`, `cron`, `runAt`, and `nextRunAt`; a null next occurrence terminates a one-time schedule. `Scheduler.passOne` checks existence of a due timestamp, enabled schedule/bot, date validity and transient retry delay before admission (`apps/server/src/automations/scheduler.ts:271–291`). Successful admission advances the latest row; refusal leaves it due. `Automations.start` synchronously tests/adds its in-flight set and clears it in a finalizer (`apps/server/src/automations/automations.ts:99–114`), so there is no arbitrary JS interleaving between membership test and add. `tick` joins an existing deferred and runs its pass uninterruptibly (`scheduler.ts:299–320`); the production ticker is sequential (`apps/server/src/shared/ticker.ts:21–39`). Normal shutdown therefore waits for recording, unlike a hard process crash.

The important invalid transition is concrete: an older admission consumes a newly edited one-time occurrence because `advancing` rereads the latest cron but does not compare its due timestamp/version (`scheduler.ts:257–269`; F12). Prompt retries use stable request identities and production bot dispatch finds existing executions; script retries do not (F06). Restart retains due dates, loses retry delays and in-flight membership, and reconsiders due rows.

Executed tests: `apps/server/src/automations/scheduler.test.ts:245`, “dispatches a due one-time schedule exactly once and persists completion,” checks one dispatch/null next date across subsequent ticks; `:442`, “retries a failed dispatch with the same occurrence key after backoff,” checks identical keys and eventual completion; `:485`, “stopping waits for a dispatch in progress and records it,” gates admission and checks shutdown blocks until recording. None edits an occurrence during admission or retries an already-admitted real script after bookkeeping failure.

<a id="group-i02"></a>

#### I02 — Event-run delivery — **P1** (F06)

`EventRepository.storeEvent` inserts an event and invokes its consumers inside one transaction; duplicate event insertion returns without creating consumer runs (`apps/server/src/event-sources/event-repository.ts:85–111`). `EventRunRepository.record` snapshots enabled source consumers/bots into pending rows (`apps/server/src/automations/event-run-repository.ts:49–78`). `nextPending` orders by relay event ID and selects one pending row per schedule (`:80–100`), rather than one unfinished bot execution. The dispatcher changes admission success to `dispatched`; missing/disabled targets fail immediately; refusal changes nothing; exceptions increment attempts, delay transiently for 30 seconds, and fail at ten (`apps/server/src/automations/event-dispatcher.ts:30–80`). Therefore dispatched is deliberately not completed bot work.

The production start path uses a sequential ticker, and Automations protects concurrent admissions; a speculative overlapping-tick duplicate is not established merely because the service exposes `tick`. The demonstrated ownership defect is instead the gap between script admission and event-run marking: no durable trigger identity joins them (F06). Prompt dispatch uses `eventRequest` and reuses the bot execution. Restart resumes persisted pending rows with persisted attempt counts but resets retry delays. Event retention also cascades run removal, bounding recovery to retained data.

Executed tests: `apps/server/src/automations/event-runs.test.ts:97` checks exactly two runs and zero on duplicate ingestion; `:117`, “a run that cannot be recorded leaves no event, so the redelivery stores it,” verifies rollback and successful redelivery; `:150` checks pending ordering; `apps/server/src/automations/event-dispatcher.test.ts:194` checks backoff/exhaustion; `:242` checks busy script refusal does not consume an attempt. Script dispatch in that fixture is a stub, not the real ScriptRuns-to-event-mark recovery boundary.

<a id="group-i03"></a>

#### I03 — Script automation execution — **P1** (F06)

A persisted row starts `running` and settles `succeeded`, `failed`, `timed_out`, or `interrupted`; its ID is random and its schema has no occurrence/event/request identity (`apps/server/src/automations/schema.script-runs.ts:5–26`). Admission serializes globally through one permit, adds schedule membership before creating the row, and forks into an owned execution scope (`apps/server/src/automations/script-runs.ts:180–195`, `:278–331`). Four execution permits bound account concurrency. A fifth admitted row may legitimately be running while waiting for a permit. Same-schedule overlap is blocked until finishing/notice handling clears membership. Shell nonzero/timeout/exception outcomes are terminal, not automatic command retries (`:128–164`, `:217–276`).

Normal cancellation closes the owned scope, aborts shell work, and finalizes both executing and permit-waiting rows. Closing admissions are serialized and cannot leak a successful row without a finalization attempt (`:188–195`, `:309–331`). Startup `recover` marks leftover running rows interrupted (`:334`; `apps/server/src/automations/script-run-repository.ts:87–97`), and account startup invokes it before dispatchers (`apps/server/src/app/tenant.ts:348–356`). This does **not** prevent the automation admission retry from creating another row for the same trigger (F06). Finish-before-notice also means a crash can lose a result notice; there is no persisted notice retry, but command completion remains recorded.

Executed tests: `apps/server/src/automations/script-runs.test.ts:292` checks same-schedule exclusion/re-admission; `:305` bounds running commands to four; `:412`, `:436`, `:444` verify close/permit/create races settle rows; `:473` verifies recovery interruption; `:399` verifies notice failure does not fail the run or block later admission. None links repeated automation trigger identity to the admitted row.

<a id="group-i04"></a>

#### I04 — Event relay handshake, acknowledgment, reconnect — **OK** within inspected scope

Transient representation includes `connection`, `greeted`, configuration fingerprint, mismatch and closed flags plus shared reconnect state (`apps/server/src/event-sources/event-relay.ts:85–101`). A valid hello establishes connected state. An incompatible hello blocks reconnect until configuration changes (`:143–164`, `:213–235`). Callback processing checks connection object identity; loss from an obsolete socket cannot clear a newer socket (`:119–135`). Reconcile reads URL/token, invalidates a changed connection, respects retry gating, and avoids opening another socket while one exists (`:221–239`). Shutdown marks closed and disconnects (`:279–284`).

Event callbacks persist through `storeEvent` before ack, and only ack while that socket is still current (`:168–184`). Thus rejected hypothesis: disconnect between persistence and ack loses the event. It instead permits redelivery; the event/run transaction and unique event ID deduplicate it (`apps/server/src/event-sources/event-repository.ts:85–111`). Cancellation or process crash before commit permits redelivery; after commit/before ack also permits harmless redelivery. Acks are not evidence that bot work completed. Restart reconstructs the outbound connection and relies on relay redelivery, not an in-memory backlog.

Executed tests: `apps/server/src/event-sources/event-relay.test.ts:175`, “the relay connects with the account token, stores each event once, and acks it,” asserts two acks/one stored event; `:209` verifies protocol mismatch blocks until reconfiguration; `:230` and `:251` assert reconnect delays/flapping backoff. Transaction rollback is separately tested at `apps/server/src/automations/event-runs.test.ts:117`. No transport hang/absent-hello fault experiment was run, so this review does not claim liveness under every malformed server/half-open-network condition.

<a id="group-i05"></a>

#### I05 — Gateway connection ownership — **OK** within inspected scope

Per-adapter reconnect state carries optional connection/token, generation and invalidation flag; reconciliation/reconfiguration membership adds ownership guards (`apps/server/src/message-gateway/gateway-connections.ts:67–110`). Token/enablement changes cancel workers and stop old handles (`:149–185`); stop increments generation and detaches the connection before awaiting close (`:124–142`). Callbacks reject obsolete generations (`:194–227`). Connect wraps the adapter promise with a continuation that closes late results; timeout/failure increments the generation, so even a login resolving after timeout cannot become current (`:230–250`, `:291–311`). This specifically rejects a plausible stale-open resource leak hypothesis.

Reconfiguration serializes settings mutation, marks the adapter unavailable, stops its handle, cancels workers, then persists settings, finally clearing the reconfiguring guard (`:355–379`). Receipt scheduling rechecks connection identity/generation after asynchronous authorization. Scope finalization sets closed before stopping every state (`:382–388`). Startup reconstructs all transient handles from saved config/token; retry counters themselves reset. Invalidation is a reconnect request, not every diagnostic error.

Executed tests: `apps/server/src/message-gateway/message-gateway.test.ts:355`, “a connection resolving after its timeout is closed and cannot submit messages,” checks closure/obsolete message suppression; `:585` checks revoked authorization suspends work and old callbacks are retired by token replacement; `:704` checks diagnostic errors do not recreate a healthy handle; `:865` checks a held send leaves configuration and other channels responsive; `:945` gates scheduling and checks owner revocation prevents submission. These real coordinator tests use fake transport handles and real persistence; they do not prove Discord network delivery behavior.

<a id="group-i06"></a>

#### I06 — Discord client/outbound settlement — **OK** within inspected scope

Connection closure and per-send abort controllers govern sends, while `watchClient` separately emits one host invalidation per session (`apps/server/src/message-gateway/discord/adapter.ts:195–227`). Login failure destroys the client and removes listeners even if destruction also fails (`:229–246`). Each send combines a connection-owned controller with a ten-second deadline, registers it before awaiting REST, validates a nonempty returned ID, and deletes its pending controller in `finally` (`:248–290`). Close first marks closed, aborts pending sends, destroys the client, and removes listeners (`:293–324`). The SDK is configured with no REST retry queue and rejects rate limits to the durable coordinator (`:331–350`).

Partial external success is ambiguous if REST acceptance races timeout/cancellation; the adapter does not assert exactly-once delivery. It supplies deterministic hashed per-chunk nonces and `enforce_nonce` so retry can reuse identity (`:176–193`). Whether Discord still remembers a nonce after a very long outage is provider-owned and was not verified; I do not turn this unverified provider behavior into a confirmed defect. Process crash loses controllers/client, but the receipt persists.

Executed tests: `apps/server/src/message-gateway/discord/adapter.test.ts:161` checks repeated input gets identical bounded nonce and mentions stay disabled; `:210` checks idempotent close/removal of listeners; `:229` checks pending send abort before destroy; `:256` checks deadline abort/sanitized error; `:287` checks queue cancellation; `:342` checks rate limits escape for durable retry; `:481` checks explicit invalidation notifies once. These are transport-fake tests; no real Discord send was attempted.

<a id="group-i07"></a>

#### I07 — Gateway receipt delivery — **OK** within inspected scope

A durable pending receipt contains fixed bot selection/request ID, optional execution/chunks, persisted sent IDs, attempts, retry deadline and expiry (`apps/server/src/message-gateway/message-gateway.ts:139–179`; `apps/server/src/message-gateway/schema.ts:8–47`). Duplicate incoming messages conflict on receipt identity rather than replacing work. `receiptExecution` first reads the execution ID or agent/request identity, then submits only if absent (`apps/server/src/message-gateway/gateway-delivery.ts:57–80`). This rejects the submission-before-receipt-save crash duplication hypothesis: restart finds the existing bot execution. Chunks freeze the response and each send uses the sent-count index plus stable nonce; progress and reply routing persist transactionally (`:118–180`; `apps/server/src/message-gateway/gateway-repository.ts:96–149`).

One scheduling semaphore protects the worker map, four workers bound concurrency, and per-adapter/channel exclusion prevents concurrent sends on a channel (`gateway-delivery.ts:254–262`, `:347–409`). Connection/config checks occur before submission/send. Interruption-only failures do not consume attempts; permanent errors, ten failures or 24-hour expiry settle failed (`:231–251`, `:309–345`). Restart picks pending rows up automatically; persisted cooldowns survive it. A process crash after an external send but before save remains an ambiguous-delivery window mitigated, not mathematically eliminated, by Discord nonce enforcement.

Executed tests: `apps/server/src/message-gateway/message-gateway.test.ts:416` verifies execution recovery across another chat; `:457` asserts duplicate/concurrent passes submit once; `:507` reopens the real database; `:536` verifies exact concatenated multi-chunk answer, persisted progress, stable failed-send nonce, and no resubmission/re-reading; `:754` verifies durable adapter cooldown; `:838` checks retry/expiry exhaustion. `apps/server/src/message-gateway/gateway-repository.test.ts:117` explicitly verifies chunk progress and reply mapping survive reopening together. No assertion of unlimited-time provider-side deduplication is warranted.

<a id="group-i12"></a>

#### I12 — Push ingestion, outbox, presence — **P1** (F13)

`PushDelivery` listens for non-bot-origin reply activity, queues it, and has one consumer persist replies separately from network sends (`apps/server/src/push/push.ts:235–284`). Enqueue transactionally deduplicates the event and inserts per-enabled-device deliveries (`apps/server/src/push/push-repository.ts:201–251`). Pending delivery uses delivered flag, attempts/deadline, expiry and enabled device (`:254–285`). A one-permit uninterruptible drain avoids overlapping sends and waits on normal shutdown (`push.ts:141–193`). Fresh two-minute presence suppresses only matching bot-chat notifications, not group answers (`push.ts:159–179`; `push-repository.ts:180–199`). Rejected token handling re-reads registration, requeues observed rotations, and conditionally disables only the rejected token (`push.ts:39–61`).

The invalid transition is that one failed enqueue terminates the sole ingestion fiber; ticker recovery only drains already-persisted work (F13). Shutdown flushes replies still queued and then drains, but cannot restore the failed reply already taken. Process crash also loses any transient unpersisted queue; restart only resumes durable outbox rows. External success before delivered marking may cause a duplicate push after a hard crash; event IDs/collapse payloads assist client/provider handling but do not constitute transactional external delivery.

Executed tests: `apps/server/src/push/push.test.ts:331` checks presence suppression and one send across concurrent drains; `:377` checks expiry and rotation before rejection settlement; `:466` checks transient backoff/eventual second-attempt delivery (despite its name, does not reach exhaustion); `apps/server/src/push/push-lifecycle.test.ts:137`, `:174` check send/shutdown/queued reply ordering; `:232` verifies recovery after a pending-read failure, not enqueue failure. The new throwaway repro demonstrates the untested ingestion-fiber failure.

<a id="group-i13"></a>

#### I13 — APNs request settlement — **OK** within inspected scope

`apnsRequest` allocates an HTTP/2 session and stream; `settled`, response text and a 15-second timer arbitrate success/error/timeout (`apps/server/src/push/push-transports.ts:165–218`). The response is resolved only on end, with decoded optional provider reason. Error and timeout set settled before rejection; repeated error/end callbacks cannot settle again. Successful/error settlement clears the timer; timeout destroys the request and its later error is ignored. A promise `finally` closes the session. Synchronous throws inside the Promise executor also reject and reach that cleanup. The send is intentionally not normally cancelled midway by Push drain, which is uninterruptible; hard crash cannot record a final outcome.

Provider classification, not merely HTTP response existence, drives the outbox: rejected device tokens become PermanentRejection; 429/5xx temporary; notification-level 4xx terminal; credential rejection is not misclassified as device-token rejection (`:305–357`, `:30–41`). A retryable failure returns to durable delivery. A crash after APNs accepts/before persistence leaves ambiguous success and can resend; there is no application-side transactional tie to APNs.

Executed tests: `apps/server/src/push/push-transports.test.ts:259` checks addressing/expiry headers; `:332` checks rejected token reasons; `:347` temporary statuses; `:359` terminal versus credential responses; `:371` enforces delivered only for success range. These test builders/classifiers, **not the private HTTP/2 request callback race**. No live APNs call or callback-order fault injection was executed. Static tracing found no confirmed competing-settlement defect.

### Numbered local findings

<a id="finding-f12"></a>

#### F12 — P1 / high confidence / I01 — Completing an old admission erases a newly scheduled one-time occurrence

**Evidence:** `apps/server/src/automations/scheduler.ts:177–219` updates a schedule, computing its fresh next date; `:257–269` subsequently rereads the latest row and overwrites `nextRunAt` with null for any non-cron schedule without checking it is the occurrence that was admitted. `:288–291` calls this advancement only after asynchronous admission. `apps/server/src/automations/schedules-api.ts:39–55` exposes update through the normal HTTP path. `apps/server/src/automations/schedule-repository.ts:128–142` performs the next-date update by schedule ID alone.

**Minimal sequence/preconditions:** An enabled one-time schedule is due. Its dispatch is still awaiting durable bot admission. During that wait, the owner changes `runAt` to a future time and optionally edits the prompt, and the update succeeds. Then the older admission succeeds. No parallel ticks or database corruption is necessary: the dispatch Promise itself supplies the asynchronous gap, and schedule update is not behind the tick's deferred/admission lock.

**Violated invariant/outcome:** Advancement may consume only its captured occurrence; a successful edit that schedules a different occurrence must survive completion of the old admission. Actual result: row retains the new `runAt`/prompt but `nextRunAt` becomes null, so the newly configured run never fires. The scheduler does not compare old/current due time or row revision. Restart persists this lost occurrence; ordinary tick/retry cannot repair it.

**Reproduced:** `scheduler-edit-repro.ts` uses the real Store and real Scheduler through the existing `standaloneScheduler` seam; only external admission is a gated Promise. Before release, persisted `runAt` and `nextRunAt` both equal `2026-11-08T20:30:19.118Z`. After release, `runAt` is unchanged and **`nextRunAt: null`**. Exact output is in `scheduler-edit-repro.log`. This proves bookkeeping loss, not a mock implementation of advancement.

**Impact/severity:** Meaningful user-visible silent loss of an automation run, isolated to the edited automation; no security exploit required. Requires editing during admission, so likelihood depends on admission latency, but the outcome is deterministic under that public sequence. P1 rather than complexity/test-only concern.

**Test gap/proposal:** Extend `apps/server/src/automations/scheduler.test.ts` beside the gated shutdown test at `:485`: gate the real AutomationDispatch, call tick for old due time, update via Scheduler.update to a future one-time date, release admission, assert new next date remains and tick at that date dispatches the new prompt. Actual baseline nulls it. Use an occurrence/version compare-and-swap in the same owner of schedule advancement; only the matching admitted revision/due should advance. A generic FSM wrapper is unnecessary.

<a id="finding-f06"></a>

#### F06 — P1 / high confidence (source-proven, not reproduced) / I01, I02, I03 — Script admission has no durable trigger identity, so bookkeeping recovery can run the same command twice

**Evidence:** `apps/server/src/automations/automations.ts:41–44`, `:66–84`, `:86–96` generate/use deterministic identity for prompt dispatch but call `scripts.start(schedule, event)` without occurrence/event admission identity for scripts. `apps/server/src/automations/script-runs.ts:278–331` creates a new random row every admitted start and only transiently suppresses overlap. `apps/server/src/automations/schema.script-runs.ts:5–26` stores no trigger key or unique trigger constraint. `apps/server/src/automations/scheduler.ts:288–291` advances the occurrence after start; `apps/server/src/automations/event-dispatcher.ts:60–69` marks an event dispatched after start. `apps/server/src/automations/script-run-repository.ts:87–97` changes leftover running rows to interrupted; it supplies no trigger lookup. Contrast production prompt recovery at `apps/server/src/bots/bots-submissions.ts:123–140`, which finds/reuses the execution by agent/request identity.

**Minimal sequence/preconditions:** A due scheduled script or pending event script is admitted: its running row is committed and its execution fiber is forked. Before the separate schedule-advance/event-mark write commits, the process crashes, or that bookkeeping write fails. The command may already have made an external side effect (the script runs immediately). On crash, restart marks the old row interrupted and loses in-flight sets; on normal bookkeeping failure, wait until the first script finishes and releases its set membership. Retry sees the original occurrence still due/event still pending, calls ScriptRuns.start again, creates a fresh random run, and executes the command again.

**Violated invariant/outcome:** Durable admission, not command completion, is the scheduler/event dispatch milestone. An admitted trigger must reuse its admitted script row when its acknowledgment is retried, just as prompt admission does. Instead the durable running/succeeded/interrupted row cannot be associated with that trigger. The code-proven result is a second admitted row and repeated command execution if retry follows the described gap. A hard crash need not occur mid-command: it can occur after a very fast command completed and before the acknowledgment write. Normal disk/write failure at the latter write is another real seam, not arbitrary row corruption.

**Reachability/recovery:** Normal owner/bot-created script schedules and event relay consumers reach these paths; no internal API bypass is required. ScriptRuns.recover runs before dispatcher/scheduler startup (`apps/server/src/app/tenant.ts:348–356`) but only settles old row status. Consequently startup does not reject the repeated trigger. Repeated acknowledgment failures can cause further duplicates (event retries are eventually bounded; schedule retries are not). The script's own external side effects may or may not be idempotent; nothing in the contract requires every shell command to be idempotent.

**Impact/severity:** P1 because arbitrary scheduled shell commands can repeat meaningful external effects even though admission was durable. Limited to a script whose acknowledgment hits a crash/write failure window; lower likelihood than an everyday failure but potentially significant per-command impact. This finding does not demand exactly-once external command completion after a mid-command crash. It demands deduplicating the already-recorded *admission* so recovery preserves the declared interrupted-not-rerun policy.

**Existing-test gap:** `apps/server/src/automations/scheduler.test.ts:125` uses recording ScriptRuns, not the real persistence boundary. `apps/server/src/automations/event-dispatcher.test.ts:242` stubs script admission too. `apps/server/src/automations/script-runs.test.ts:473` tests interrupting rows but not subsequent trigger redelivery. None faults the write after successful real admission.

**Deterministic proposed test (not executed):** Build the real Scheduler/Automations/ScriptRuns layers with the existing directory-backed workspace seam (`apps/server/src/automations/script-runs.test.ts:29–105`) and real product database. Wrap only ScheduleRepository.updateNextRunAt to die once **after** a real successful script admission. Use a command appending one marker to a throwaway file; wait until the real script row settles, tick the same due occurrence again. Expected one admitted row/one marker with advancement retried; current code produces two rows/two markers. Repeat for EventRunRepository.mark failing once after real script admission and advance TestClock through its retry delay. A restart variant can gate advancement and reopen the store after killing the isolated process. Do not mistake a stub incrementing an admission count for execution proof.

**Boundary recommendation:** Pass the deterministic trigger key into ScriptRuns and persist it with a uniqueness constraint/reuse result, or commit script admission and occurrence/event acknowledgment in a shared product-database transaction before execution can start. This is a demonstrated atomicity/deduplication boundary, not an argument for a general state-machine framework.

<a id="finding-f13"></a>

#### F13 — P1 / high confidence / I12 — One outbox enqueue failure permanently stops live push ingestion

**Evidence:** `apps/server/src/push/push.ts:242–260` retains an activity subscription/queue; `:263–272` runs the sole `Queue.take` → `push.enqueue` loop as a scoped fiber without a catch/retry/restart. The `uninterruptibleMask` protects shutdown cancellation, not defects. Real repository enqueue uses `Effect.orDie` around its transaction (`apps/server/src/push/push-repository.ts:201–251`), so a transient SQLite/storage failure terminates that fiber. The separate polling fiber only invokes `push.drain` (`push.ts:274–284`); it does not consume or re-persist replies. Only scope finalization flushes replies still in memory (`:249–252`).

**Minimal sequence/preconditions:** PushDelivery is active with an enabled registered device. A reply is taken from the activity queue. That enqueue transaction fails once, e.g. a transient storage failure; storage then becomes healthy. Further reply events arrive. The subscription still accepts them, but the only consumer is dead. Polling and successful drains operate on the outbox, which never receives those replies.

**Violated invariant/outcome:** A transient persistence failure should not permanently end admission for every subsequent reply. Actual live outcome is account-wide silent cessation of push delivery until runtime teardown/restart. The failed taken reply itself is lost rather than retained/retried. Later replies remain only in unbounded memory, so a hard crash loses them too and sustained activity can accumulate memory. Graceful shutdown salvages the still-queued later replies, but does not recreate the already-taken failed reply; it can also deliver them much later than intended.

**Reproduced:** `push-ingestion-repro.ts` constructs real PushDelivery, real Push and SQLite PushRepository, wrapping only repository.enqueue with a one-shot defect equivalent to the real `orDie` failure mode. A real fake-provider send counter receives no pushes after storage recovers, two more replies arrive, TestClock advances five seconds, and an explicit successful real drain runs. Output: `{"phase":"while live after subsequent replies and successful drain","attempts":1,"sends":0}`. Closing the runtime flushes the queue: `{"phase":"after shutdown queue flush","attempts":3,"sends":2}`. This isolates failure of the actual consumer, not a mocked reimplementation. The assumption about a real transient disk error is represented by controlled fault injection; the downstream dead-consumer behavior is observed.

**Reachability/severity:** Activity comes from production BotActivity wiring (`apps/server/src/app/tenant.ts:223–232`, `:264`), with no privileged caller required. Impact is all subsequent push-worthy replies for that account; other bot work and already-durable outbox delivery may continue, making this easy to miss. Requires one storage fault, not permanent storage failure. P1 for persistent user-visible notification loss.

**Existing-test gap/proposal:** `apps/server/src/push/push-lifecycle.test.ts:232`, “a failed background pass is logged, and polling delivers once the outbox reads again,” injects `pending()` failure, after persistence; it therefore does not test this consumer failure. Extend its observedRepository seam to inject one failure in enqueue. Emit reply A, wait for failed enqueue, emit B/C, restore storage and advance TestClock. Expected admission retries A and continues B/C, each event persisted/sent once; actual A is lost and B/C wait for shutdown. Recovery should keep/retry the taken reply and continue the consumer loop (with bounded delay/logging), not merely add another catch around drain. Preserve the existing cancellation-safe queue handoff/finalizer ordering.

### Coverage limits and rejected escalations

* Inspected admission, persistence, worker ownership, retries, external-send progress, startup recovery and shutdown for exactly the assigned nine groups. Other machine IDs were consulted only at necessary boundaries (production bot request deduplication and account startup wiring).
* No real Discord/APNs/FCM/remote relay service or real workspace backend was contacted. Existing relay tests use local fake WebSocket servers; adapter sends are fake. APNs callback settlement was statically reviewed; its existing classifier/header tests are not callback-race coverage.
* Did not independently verify provider nonce-retention/collapse semantics, Discord/HTTP2 dependency internals, or remote event relay retention. Consequently ambiguous external send windows are documented but not promoted to unproven security/exactly-once findings.
* Did not classify missing guards/tests alone as defects: scheduler tick coalescing, production sequential dispatcher tick, synchronous set membership, stale generation checks and durable bot request deduplication were explicitly traced before rejecting race/duplication hypotheses.
* Source-proven F06 still needs the proposed real-boundary fault-injection regression test; no script duplicate execution experiment was executed. Two other findings have executed, no-mutation reproductions.
* No repository edits, code mutations, CI changes or full-repository checks were made. Existing targeted test suite passes in 6.51s; that is local execution time, not a changed CI-job duration claim.

<a id="secrets-skills-review"></a>

## Secrets, skills, search, and lifecycle ports

### Scope and evidence

Reviewed **I14, I15, I16, J15, J16, J17, J18, J21, J22 (9 groups)** against actual production implementations, dependency boundaries, and tests. Verdict: **one P1 finding (J16); eight groups OK within the inspected scope.** No P0, P2, or P3 findings. “OK” is not a claim of exhaustive verification of every network ordering.

The requested baseline is `d5de813`. The checkout is `95570dd0519ca22b8a3361b26af8e23c59f687a0`; `git diff d5de813 HEAD --stat --` for the nine groups' source directories produced no differences. The untracked inventory `docs/implicit-state-machines.md` was read as a scope hypothesis. Read the supplied brief, repository instructions, `GLOSSARY.md`, and ADRs `docs/adr/0003-learned-skills.md` and `docs/adr/0006-credential-proxy.md`. Repository files were not edited. Paths below are relative to `/Users/leonhardbreuer/Developer/crumble-project/bot` unless explicitly absolute.

#### Executed evidence

1. Ran the existing tests in `secret-values.test.ts`, `secrets.test.ts`, `password-manager.test.ts`, `password-managers-api.test.ts`, `credentials.test.ts`, `credential-proxy.test.ts`, `credential-authority.test.ts`, `logins.test.ts`, `skill-installer.test.ts`, `skill-curator.test.ts`, `owner-skills.test.ts`, `bot-extensions.test.ts`, and `mixed.test.ts`, all under their corresponding `apps/server/src` directories: **95 pass, 0 fail, 241 assertions, 1.97 seconds**. Full command/output: `/tmp/crumble-state-review-d5de813/secrets-skills-tests.log`. The logged “No chat takes bot notices yet” is expected by the passing notice-failure test, not a failed test.
2. Ran `bun test apps/server/src/bots/runtime-behavior.test.ts apps/server/src/bot-desktop/computer-use-login.test.ts`: **34 pass, 0 fail**. Full output: `/tmp/crumble-state-review-d5de813/secrets-skills-boundary-tests.log`. These are hermetic runtime/fake-driver tests, not simulator/emulator tests.
3. Ran the real production login implementation with a SQLite statement-failure injection in a temporary database. Script and exact output are described in Finding F10. This was not a mocked implementation. The first attempt failed only because Bun did not resolve an absolute directory import of Effect; the script's import was corrected to its installed `dist/index.js`, and the successful run is the evidence cited below. Read the installed Effect `AGENTS.md` completely before writing this reproduction.

### Per-group analysis

<a id="group-i14"></a>

#### I14 — Installed-skill check and update — OK

Installed state is durable `Skill.origin` (repository/branch/path/commit/digest); candidate/check time lives separately in `skillUpdates`. Browse status is derived, not an authorization token (`apps/server/src/skills/skill-installer.ts:146-170`). Install validates fetched paths and all skill names before the database transaction creates every selected skill (`:296-346`). Checks group by repository/branch, record current digest or `null` for a removed main document, and collect per-branch failures rather than destroying the installed content (`:373-439`). Preview and apply fetch the recorded immutable commit, not a moving branch; removed/invalid upstream content is refused (`:441-474`). Apply checks shared-name clashes and atomically updates content, documents, and origin through `SkillRepository.update` (`:483-507`; `skill-repository.ts:213-239`).

Rejected hypothesis: upstream failure silently overwrites the usable installed copy. It only returns a failed check or preview/apply error. Installed owner edits are also refused (`owner-skills.ts:118-132`); bot targeting only permits own skills (`skill-manage.ts:237-255`). Restart retains both installed content and candidates; startup immediately checks due records and then repeats hourly (`skill-installer.ts:523-537`). The existing transaction protects selected installs against partial creation; it does not make concurrent upstream snapshots a distributed monotonic-version protocol. I did not reproduce overlapping manual/background check orderings.

Executed tests: `skill-installer.test.ts:190`, “installs read-only shared skills with their documents, all or none,” checks persisted document/origin and refusal leaving the library unchanged; `:238`, “finds upstream changes…,” checks script-only changes are ignored, preview/apply content and commit, cleared update state, revert, and upstream removal; `:290` checks daily skipping. Their assertions are substantive, but do not gate concurrent checks.

<a id="group-i15"></a>

#### I15 — Skill aging and per-turn write authorization — OK

Durable aging state is `active/stale/archived`, usage timestamps, `updatedAt`, creation provenance, and pinning. The curator only considers bot-created, unpinned, unarchived skills; activity thresholds are 14/30 days, and schedules naming the skill exempt it (`apps/server/src/skills/skill-curator.ts:27-94`). `recordUse` increments usage and changes only stale → active with a SQL CASE, so an arbitrary read cannot resurrect an archived skill (`skill-repository.ts:279-291`). Startup and six-hour curation are scoped (`skill-curator.ts:106-122`).

Write authorization is a transient, bounded map of run keys to skill IDs (`skill-library.ts:59-76`). Keys derive from conversation ID plus stable input submissions, not changing per-round task IDs (`:30-47`). The actual runtime marks reads and records use (`bots/runtime.ts:373-385`); mutation targeting re-resolves this bot's own skill, checks this turn's read, and rejects shared/default writes (`skill-manage.ts:237-255`). Pinning is separately rechecked by `BotSkills` (`skills.ts:92-104`). Creation authorizes the created ID; whole mutation batches join one database transaction (`skill-manage.ts:465-472`; `skills.ts:165`). Restart/eviction can conservatively require another read, not grant unauthorized writes.

Executed `bots/runtime-behavior.test.ts:336`, “a bot writes its own skills atomically, after reading them, and every change is recorded,” asserts unread refusal, successful patch/document/create, failed later batch rollback, and stored content. Executed `skill-curator.test.ts:21` asserts thresholds, exemptions, idempotence, stale reactivation, and restoration; `:141` verifies startup/six-hour passes. `skill-installer.test.ts:313` verifies bot/review pin refusal. Telemetry record failure and stale inline replacement are accepted ADR 0003 policy, not atomicity defects.

<a id="group-i16"></a>

#### I16 — Mixed search fallback and vendor initialization — OK

Per-request search captures a synchronously advanced rotating cursor; vendor failures advance through Exa/Parallel/Tavily and exhaustion becomes a typed `WebSearchError` (`apps/server/src/web-search/mixed.ts:89-120`). A successful empty/filtered result is success, not a failed vendor; that is the implemented fallback contract. Domain/date filters and result limits are applied after success (`:20-53`). Initialization state is transient per-provider maps: a per-bot semaphore, absent/present session ID, and the initializing call (`:56-85`). The semaphore rechecks presence inside its permit. It retains the initializing response for that caller and supplies its session ID to later calls. A response without a session ID stays retryable rather than inventing an initialized state.

Rejected race: a second initial query necessarily creates its own session, or a blocked bot serializes every bot. The permit is per bot, with a second presence check; other bots have independent permits. Failures/interruption release permits. Vendor transport acquisition is scoped, MCP calls receive cancellation signals, and vendor operations have timeouts (`vendors.ts:48-114`, `:177-220`, `:222-268`). Process restart intentionally loses rotation/session caches and reinitializes; there is no durable unfinished search to recover.

Executed `mixed.test.ts:27`, “concurrent initial searches reuse the bot's Parallel session and do not block other bots,” gates the first call and asserts exact call/session sequence. Its parameterized “waiting search proceeds after initialization failure/interruption” at `:76` checks both retry paths and reuse of the recovered session. Vendors are mocked there, so these tests prove provider orchestration, not actual third-party network/session longevity. No live services were contacted.

<a id="group-j15"></a>

#### J15 — Credential/login request fulfillment — OK

Pending requests are durable rows keyed by bot/kind/name. `ask` upserts metadata; `close` deletes with `returning` and emits a notice only if it actually deleted a row (`apps/server/src/bot-secrets/bot-secret-requests.ts:90-107`, `:128-159`). Saving obtains hosts from explicit input, current saved record, or pending request; validates before slow storage and re-reads/rechecks after it (`bot-secret-lifecycle.ts:75-105`). Admission refuses redundant asks only when the existing record covers every requested host; login asks may request a missing one-time-code field (`:108-133`; `logins/logins.ts:254-271`). No numeric status enum is needed for these states.

The deletion result prevents duplicate answers on ordinary retries; the second decline returns a conflict. Saved record deletion and request decline are intentionally different branches (`bot-secret-lifecycle.ts:136-164`). Requests survive restart as rows. Notices are best-effort after row deletion: `requestAnswers` logs handler failures (`bot-notices.ts:55-63`; `shared/app-errors.ts:21-24`). A crash before notice admission or a rejected notice can lose the wake-up; there is no request-notice outbox/replay. I record that residual limitation rather than claiming exactly-once delivery or treating the deliberately tolerated “nothing takes notices” case as a new defect. Durable bot execution recovery applies after an execution exists, not before (`bots/bots-submissions.ts:61-103`; `bots/bots-lifecycle.ts:56-61`).

Executed `credentials.test.ts:84` checks answer deletion and one notice; `:140` explicitly checks save succeeds without a handler; `:367` gates a slow reference read and verifies a concurrent host narrowing is preserved. Executed `logins.test.ts:425`, `:446`, `:465`, `:476`, and `:515` check answer, decline/retry, replacement, host conflict, and missing-code admission. The storage partial-failure defect is Finding F10/J16, not duplicate fulfillment.

<a id="group-j16"></a>

#### J16 — Secret and login save validation — P1 (Finding F10)

Validation correctly precedes storage: `Secrets.save` obtains and optionally verifies a value before storing it; `saveAll` checks every entry before its storage loop (`apps/server/src/secrets/secrets.ts:69-144`). References bypass stale-cache fallback through `readNow`; malformed/unreadable values become `InvalidInput`. Login completeness is checked both before and after slow work (`logins/logins.ts:197-252`; `bot-secret-lifecycle.ts:80-101`). Item-based one-time-code removal requires a confirmed `missing-field`, not a timeout or generic unreadability (`logins/logins.ts:173-193`; `secrets/secrets.ts:155-170`). Volatile manager-generated codes bypass local TOTP parsing/derivation (`logins/logins.ts:164-171`, `:278-301`).

However, checked fields are then written as independent SQLite statements without a transaction; optional code deletion and login metadata come later. A failure in the second field leaves the first changed in a failed save. This is not an invented JS interleaving: a real SQLite trigger failure reproduced it against `Logins.save`. A process crash between independently committed statements has the same durable mixed-generation window. Restart has no batch recovery record, so it cannot repair the pair; an explicit complete retry is required.

Executed `secrets.test.ts:202`, “a value verify refuses isn't stored,” and `:219`, “saveAll stores nothing when one entry can't be read,” verify **validation atomicity only**. Executed `logins.test.ts:174` preserves a code on an inconclusive probe; `:200` proves volatile reread/no stale fallback; `:251` checks invalid TOTP rejection; `:313` checks unreadable-reference rejection. These are meaningful assertions but none injects a post-validation write failure. Finding F10 supplies the missing real-storage evidence.

<a id="group-j17"></a>

#### J17 — Secret cache freshness and invalidation — OK

The cache stores redacted value/read time/refreshing flag by manager + reference; clients are manager-scoped. Fresh values live for one hour, background refresh starts at 55 minutes, and synchronous failed reads can fall back only on manager-unreachable errors and only below the two-hour snapshot age (`apps/server/src/secrets/secret-values.ts:28-60`, `:196-233`). Missing/rejected/disconnected reads cannot choose the stale branch. `readNow` never chooses it. Volatile references are never cached (`:169-175`). Forget/disconnect increment an epoch; successful late fetches compare the starting epoch before populating cache (`:99-100`, `:161-176`, `:236-266`). Disconnect additionally invalidates the RcMap client and closes its connection scope, rather than assuming invalidation interrupts held clients.

Actual invalidators are secret replacement/deletion/prefix deletion (`secrets.ts:64-67`, `:94-111`, `:172-188`) and accepted token replacement/disconnect (`password-managers-api.ts:59-72`, `:75-87`). These are real credential/login/MCP/settings services, not unused invalidation helpers. Maps and clients are transient; restart refetches persisted references and tokens. Epoch is global, so unrelated invalidation can conservatively suppress caching, not disclose another manager's value. Forget does not promise to cancel a request that already read its source; I did not classify an in-flight authorized request completing after deletion as a demonstrated cross-host revocation bypass.

Executed `secret-values.test.ts:78`, `:96`, `:118`, `:142`, `:161`, `:180`, and `:209` assert cache hit counts, background replacement, stale cutoff, disappearance eviction, forget/refetch, in-flight disconnect, and sign-in retry. `password-managers-api.test.ts:131` asserts interruption/no old cache after token replacement. Coverage is strong for those cases; late successful `forget` completion, overlapping fetch/error ordering, and precise timeout-boundary ages are not directly gated by these tests.

<a id="group-j18"></a>

#### J18 — Password-manager session lifetime — OK

The connected wrapper owns a closed Deferred and an optional SDK client. Scoped `acquireRelease` signs in with a ten-second deadline; release fails the Deferred and clears the held client (`apps/server/src/password-managers/password-manager.ts:85-145`). Reads observe the held optional client and race the timed SDK read against the closed Deferred. This makes “still has a client object” insufficient authority after closure. Both vendors lack an SDK close API; dropping the reference and interrupting Effect reads is the deliberate lifetime boundary, not a claimed remote sign-out. Manager-specific scopes in `SecretValues` close held reads on invalidation (`secret-values.ts:109-132`, `:236-250`); failed sign-in lookup is explicitly invalidated for retry (`:150-158`).

Token adoption first verifies a proposed token in a temporary scope, saves it only after success, and then disconnects old caches/clients (`password-managers-api.ts:44-72`). Disconnect refuses known remaining references before deleting the token (`:75-87`). There is no transaction spanning a remote sign-in and persistence; a process crash after token persistence loses old transient clients anyway. Normal scope closure handles connected reads, while restart reconstructs from the stored token. No unauthorized direct SDK client caller was found bypassing the wrapper.

Executed `password-manager.test.ts:59`, `:70`, `:86`, `:99`, and `:120` assert rejected sign-in, ten-second timeout, post-close refusal, close interrupting an in-flight read, and caller interruption propagating to the vendor. `password-managers-api.test.ts:108`, `:117`, `:131`, `:153`, `:169` check rejected-token non-adoption, replacement invalidation, interrupted reads, used-reference conflict, and allowed disconnect. These are not proofs of concurrent reference-save/disconnect serializability; no such distributed guarantee was assumed.

<a id="group-j21"></a>

#### J21 — Credential interception and certificate acquisition — OK

Production wiring captures the bot ID, not a model-supplied bot ID (`apps/server/src/credentials/credential-interception.ts:28-74`; `app/tenant.ts:123-147`). The workspace proxy obtains the host from inspected SNI/HTTP bytes, checks a public DNS address, and only then hands applicable TLS connections to interception (`workspaces/workspace-proxy.ts:49-74`, `:174-180`). For each HTTP request the credential interceptor re-reads grants, matches the fixed host, detects only placeholders actually present in allowed headers (including decoded Basic authorization), awaits all secret reads, and forwards none if any fail (`credential-proxy.ts:135-170`, `:277-278`, `:349-395`). Upstream TLS targets that fixed host and a second public-only lookup (`:242-274`, `:307-327`). Thus `Credentials.value`/`Logins.value` not independently checking hosts is not itself a bypass: callers own the host boundary. The login boundary independently requires a current HTTPS/main-frame field and matching login before reading (`bot-desktop/computer-use-login.ts:53-148`, `:216-232`).

Authority acquisition uses retryable per-bot promises; repository `onConflictDoNothing` returns the persisted winner (`credential-authority.ts:168-191`; `agent-credential-repository.ts:223-244`). Certificate/key persistence survives restart; host contexts are transient and renewed within one day of expiry (`credential-authority.ts:260-274`). Failed creation is evicted for retry. No cancellation-atomic remote forwarding claim is made: after forwarding begins, the remote request may act.

Executed `credential-proxy.test.ts:190`, `:249`, `:273`, `:325`, and `:342` check lazy reads/scrubbing, Basic decoding, header scrub, unchanged URL placeholders, and 502 with zero upstream requests. `credential-authority.test.ts:5` only checks serial DER encoding; it is not lifetime/concurrency coverage. Accepted short-value scrub and optional-egress policies were excluded. ADR 0006's older query-swap wording differs from the safer current no-URL-swap implementation/test; not reported as a correctness regression.

<a id="group-j22"></a>

#### J22 — Scoped lifecycle ports — OK

`BotNotices` holds an optional handler in a Ref: registration acquires it, scope release clears it, and absence produces a failure rather than pretending delivery (`apps/server/src/bot-ports/bot-notices.ts:27-42`). Production installs one handler when `Bots.layer` is acquired (`bots/bots.ts:160-172`). Rejected hypothesis: closing an older overlapping registration clears a newer live handler in production. The primitive would allow that misuse, but I found only this single production owner; no reachable overlapping registration sequence was demonstrated.

Extension/deletion registries use scoped `acquireRelease`, Ref snapshots, and callback identity for removal (`bot-extensions.ts:24-53`; `bot-deletion.ts:25-52`). `forAgent` uses one ordered source snapshot; release does not revoke an already constructed extension result. Every production feature registration inspected creates its own closure, so removing all entries with identical callback identity is not a demonstrated deregistration bug. Deletion prepares cleanup while the bot still exists, then stops runtime/deletes the agent and runs cleanup (`bots/bots-lifecycle.ts:63-75`). Secret prefix deletion is an explicit after-delete action, not dependent on reading cascaded metadata (`bot-secret-lifecycle.ts:195-202`). Registries are rebuilt on startup; there is no durable deletion saga, and a crash after delete can leave external cleanup unfinished. That limitation is not an authorization bypass in these ports.

Executed `bot-extensions.test.ts:22`, “extensions come in position order…,” checks exact order before and after closing one registration scope. Statically inspected `app/api.test.ts:2267`, “deleting a bot forgets its own servers' secrets and connections,” which asserts disconnect and unconfigured secret after prepare/delete/clear; that large API file was **not** run in this partition. No isolated notices/deletion overlap or crash-recovery tests were executed.

### Local findings

<a id="finding-f10"></a>

#### F10 — P1 — Failed multi-field login save durably mixes the old and new login

**Confidence:** High; reproduced with the actual `Logins.save` → `Secrets.saveAll` → encrypted SQLite repository implementation. **Affected IDs:** J16. J15 is adjacent because metadata/request fulfillment is reached only after storage; this is one finding, not a separate J15 defect.

**Precise implementation references:**

- `/Users/leonhardbreuer/Developer/crumble-project/bot/apps/server/src/secrets/secrets.ts:127-144`: validates every entry, then calls `store` sequentially without a transaction.
- `/Users/leonhardbreuer/Developer/crumble-project/bot/apps/server/src/secrets/secrets.ts:94-111`: each `store` writes a repository row independently, then invalidates an old reference.
- `/Users/leonhardbreuer/Developer/crumble-project/bot/apps/server/src/secrets/secret-repository.ts:58-97`: value/reference writes are individual upserts; there is no encompassing transaction here.
- `/Users/leonhardbreuer/Developer/crumble-project/bot/apps/server/src/logins/logins.ts:217-252`: username/password/code writes, optional field deletion, and login metadata save are separate operations.
- `/Users/leonhardbreuer/Developer/crumble-project/bot/apps/server/src/bot-secrets/bot-secret-lifecycle.ts:97-105`: slow store completes before metadata rewrite and request answer; no enclosing store transaction repairs a failed field batch.

**Minimal triggering sequence:** (1) An owner has an existing login with username `old-user`, password `old-password`. (2) The owner submits a single valid save changing both fields. All validation succeeds. (3) The username upsert commits. (4) The password statement fails, or the process crashes before it commits. There is no arbitrary corrupted-state precondition and no concurrency assumption. A per-statement storage fault is required; ordinary reference-validation failure alone does not trigger this bug.

**Invariant/outcome:** A failed owner-level replacement should leave the previous coherent login, not persist one field of a replacement. Actual outcome: the operation fails, but subsequent normal reads return `new-user` and `old-password`. The existing metadata still makes that mismatched pair available to desktop fills. This is partial persistent mutation, not merely a stale cache. It requires neither access to another account nor a malicious model.

**Real public reachability:** `registerLoginRoutes` invokes `Logins.save` for the owner-facing save endpoint (`apps/server/src/logins/logins-api.ts:41-45`); no route-level transaction wraps it. The reproduction invokes the same service seam. `secretRoutes` checks the bot before calling the service, but does not add atomicity. Independent SQLite writes explain the result without assuming JS can interleave synchronous statements.

**Retry/restart and severity:** A complete successful retry fixes it. Merely restarting does not: both field rows are already committed, with no pending batch/rollback journal at this application boundary. A crash between statements has the same persistence window. Storage failure/crash frequency is low, and the demonstrated blast radius is one login; nevertheless this is a confirmed user-visible correctness bug (P1), not a P0 cross-account/security exploit. The fault injection demonstrates the result under a required write failure; it does not claim disk failures were observed in production.

**Executed deterministic reproduction:** `/tmp/crumble-state-review-d5de813/repro-partial-login.ts`. It creates a temporary real `Store`, saves an initial login through `Logins.save`, installs a SQLite `BEFORE INSERT` trigger on password keys that raises `ABORT` (a real statement failure), submits one two-field replacement, catches the failure, and reads both fields through `Logins.value`. The trigger is only in the temporary database; no production code/test file was modified. Command:

```sh
bun /tmp/crumble-state-review-d5de813/repro-partial-login.ts
```

Exit 0; output saved in `/tmp/crumble-state-review-d5de813/repro-partial-login.log`:

```json
{"failed":true,"username":"new-user","password":"old-password"}
```

This uses fake, non-sensitive values. It does not contact a password manager, start a workspace, or use a real credential.

**Test gap and regression proposal:** Existing `apps/server/src/secrets/secrets.test.ts:219` and `apps/server/src/logins/logins.test.ts:313` fail during preflight reads and correctly assert no writes in that case. They never fail the second *storage* operation. Add a real SQLite repository integration test using the demonstrated trigger/fault seam: save an old login, fail the password upsert after the username write, then assert failure **and both old values remain**. Current implementation instead persists the new username. Also include optional code deletion and metadata-host failure in the same logical-save rollback test; tests should not merely assert an error was thrown.

**Justified transaction boundary:** Do network/reference validation outside a database transaction, then commit the validated field writes/deletions and login metadata as one transaction. The invariant is owned by the owner-level login save; merely centralizing cache code or adding a generic state-machine abstraction would not fix it. Keep external notice delivery outside the SQLite transaction. `saveAll` itself can guarantee its own multi-key storage transaction, but that alone would still omit the login's subsequent code deletion/metadata update; the final boundary needs to encompass those as well. Cache invalidation after rollback may conservatively evict entries, but must not make a failed database commit authoritative.

### Limits and non-findings

- No repository changes, mutation testing, real services, credentials, workspace startup, or emulator/simulator execution. The SQLite trigger is fault injection against the real implementation, not mutation testing.
- No reassessment of job/desktop control state machines or pending OAuth records beyond the boundary callers needed to verify credential/login authority.
- Accepted ADR policies were not promoted to defects: sub-eight-character values may escape response scrubbing; job identity is unavailable for proxy logs; Railway proxy use is optional; learned-change recording is telemetry; pending reviews abort on restart; stale inline-skill replacement is documented.
- The cache epoch success guard, disconnect closure, request metadata revalidation, host-check callers, and real production port registration ownership were inspected. Existing tests do not exhaust late-error cache orderings, concurrent upstream-check ordering, or process-crash cleanup. Missing coverage alone was not classified P2.
- No broad FSM/shared-implementation recommendation. The only change proposed here is a transaction at the demonstrated multi-field/login invariant boundary.

<a id="infrastructure-review"></a>

## Server and account infrastructure

### Scope and evidence

Reviewed exactly **H01–H12 (12 groups)** from `docs/implicit-state-machines.md`, with boundary traces into actual callers and Better Auth/Hono dependencies. Read the brief, repository instructions and canonical `GLOSSARY.md`. No repository files were changed. **Final review anchor: current HEAD `95570dd0519ca22b8a3361b26af8e23c59f687a0`**, which moved externally from the inventory's `d5de813`. `git diff d5de813 HEAD -- apps/server/src/app apps/server/src/shared/secret-box.ts apps/server/src/shared/event-stream.ts apps/server/src/shared/keyed.ts apps/server/src/shared/ticker.ts` was empty, so infrastructure implementations are identical at both anchors. Inspected the changed `apps/server/src/contract/api-contract.ts`: chat SSE query now uses `snapshotInput` instead of the removed `partial` option; heartbeat/snapshot/reconnect guarantees used in H11 are unchanged. Other changed runtime/read behavior belongs to the feature reviewers. References below are repository-relative unless explicitly marked dependency. No Effect code was written (including reproductions).

**Findings:** 3 P1 (reproduced), 2 P2 (qualified below), no P0/P3. Group classifications count groups, not findings: H01 OK, H02 P1, H03 P2, H04 OK, H05 OK, H06 P2, H07 P2, H08 P1, H09 P1, H10 OK, H11 OK, H12 OK.

Executed:

* `bun test apps/server/src/app/auth.test.ts apps/server/src/shared/secret-box.test.ts apps/server/src/shared/ticker.test.ts`: **15 pass, 0 fail, 34 assertions**, 1.81 s. The ticker's deliberately injected defect logged an expected error.
* `bun test apps/server/src/app/multi-user.test.ts`: **8 pass, 0 fail, 79 assertions**, 1.56 s. Workspaces in the removal/desktop cases are in-memory test implementations; no real workspace was launched.
* `bun /tmp/crumble-state-review-d5de813/repro-auth.ts`: actual `createAuth`, actual SQLite adapter, actual admin Hono app and actual settings/invite stores; results below.
* `bun /tmp/crumble-state-review-d5de813/repro-lock.ts`: two subprocesses executing actual `lockDataDir`, gated at its filesystem write using `bun:test` `spyOn`; both acquired. An initial attempted ESM namespace assignment failed and an initial orchestrator timed out; corrected harness used `spyOn`, and the successful run exited both children with zero. No production implementation was replaced.

Server/tenant/API tests not listed as executed were read only. No browser/WebAuthn verification ceremony, full service suite, controlled mutation, real service, credential exchange or crash experiment was run.

### Dependency guarantees that change the verdict

Installed Better Auth is 1.7.14. Resolve paths under `node_modules/.bun/` as follows:

* **BA** = `better-auth@1.7.14+fe032e02aad8f797/node_modules/better-auth/dist`.
* **CORE** = `@better-auth+core@1.7.14+eb7a1e68e023ae9f/node_modules/@better-auth/core/dist`.
* **SQL** = `@better-auth+kysely-adapter@1.7.14+2c102b4072297a93/node_modules/@better-auth/kysely-adapter/dist`.
* **PK** = `@better-auth+passkey@1.7.14+cafc3d60a442cfbc/node_modules/@better-auth/passkey/dist`.
* **HONO** = `hono@4.13.13/node_modules/hono/dist`.

`BA/api/routes/sign-up.mjs:143–144` wraps the entire password creation path in `runWithTransaction`; user creation, credential linking and session creation occur inside it (`:223–273`). `CORE/context/transaction.mjs:22–27,65–114` selects the async-local transaction adapter and joins nested transactions. `SQL/index.mjs:80–83,703–711` enables real transactions for Bun SQLite. `SQL/bun-sqlite-dialect-DN2jcl8c.mjs:20–47` holds a connection mutex from acquisition through release. Thus two password sign-ups do not freely interleave their user-count/invite-consumption writes. This rejects the naive password invite double-spend and double-first-admin hypotheses.

In contrast, `PK/index.mjs:308,362–423` makes `createSession` optional and wraps persistence in a transaction **only when it is true**. `BA/plugins/admin/routes.mjs:44–78` performs permission checks and `updateUser` without a transaction enclosing Crumble's preceding admin count. SQLite serializes queries, not whole admin requests/settings operations. User `create.after` hooks are queued after commit (`BA/db/with-hooks.mjs:32–41`), so password invite attribution is not part of its successful transaction; consumption is.

### Per-group reconstruction

<a id="group-h01"></a>

#### H01 — Server bootstrap and shutdown — OK (within inspected scope)

`apps/server/src/app/server.ts:346–391` resolves configuration, validates the public origin, creates/restricts the data directory, acquires ownership, creates a tenant pool, listens, then assigns/awaits `state.ready = connectAccounts(...)`. Requests await that promise at `:276–284`; auth settings/admin construction and tenant restoration finish at `:330–343` before protected requests proceed. Startup variables are transient; auth/product databases and account directories are durable. A restart reconstructs identity and restores only existing users' directories (`:139–153`).

Shutdown sets `closed` before its first await, stops the listener, closes tenants, then closes auth and releases the lock in `finally` (`:368–378`). `closeTenants` uses two `allSettled` phases so one failed construction or failed close does not skip other tenant closures (`:90–104`). Repeated close calls return early rather than joining the first close promise; callers here await the original shutdown, so no demonstrated user failure follows from that detail. Startup failure invokes the same cleanup (`:393–396`). There is no assumed JavaScript interleaving between synchronous listener creation and readiness assignment.

Read-only tests: `apps/server/src/app/server.test.ts:108–127`, “server owns its data directory exclusively and releases it after graceful shutdown,” asserts health 200, rejects a second same-process start, and reopens after close. `:305–329`, “failed listener startup releases the push worker and data lock,” asserts `ERR_OUT_OF_RANGE` and successful subsequent startup. They do not prove cross-process ownership (F05).

<a id="group-h02"></a>

#### H02 — Data-directory ownership — P1

`apps/server/src/app/data-lock.ts:5,23–46,49–71` uses lexical resolved paths in process-local `held`, a `server.pid` record and a closure-local `released` bit. Acquisition rejects an already-held local path or a different live same-host PID, otherwise writes its own PID and marks held. Missing/malformed/dead-owner records and the same PID are treated as recoverable/watch-restart state. Release synchronously marks released, drops the local key, and removes the record only if its current PID still matches. There is no cancellation point between these synchronous steps in one process; repeated release is harmless.

The invalid transition is **two processes independently reading unowned/stale and both becoming held**: the read/liveness check and truncating write are not atomic. F05 reproduces exactly this cross-process interleaving; no JS callback interleaving within one process is required. Different-host records are also deliberately not considered live, so this is not a shared-network-filesystem lease. The record survives process crashes; ordinary restart recovers dead PIDs, but cannot repair concurrent product writes already made by two successful owners.

`apps/server/src/app/server.test.ts:108–127` verifies only the in-process held-set guard and orderly release. `:160–177`, “server takes over a data directory whose recorded owner has exited,” writes an exited child PID and verifies startup succeeds. `:179–216` simulates stale lock remnants after graceful close, not an actual killed-process crash. These are useful but do not gate competing acquisitions across processes.

<a id="group-h03"></a>

#### H03 — Tenant initialization, restoration and removal — P2

`apps/server/src/app/server.ts:165–213` owns `Map<string, Promise<Tenant>>`: absent becomes initializing by immediately storing `createTenant`'s promise; concurrent ordinary calls share it; resolved promises remain cached; rejection removes the entry for retry (`:173–190`). All map lookup/insertion operations execute before yielding, so the usual duplicate-initialization race is rejected. Account IDs are validated by `apps/server/src/app/data-dir.ts:7–10`, so directory traversal is not an admitted tenant transition.

Restoration enumerates account directories but initializes only IDs still in auth (`server.ts:139–153`). Removal evicts, awaits initialization, removes workspaces, closes, then recursively deletes files (`:197–208`). Durable deletion and transient pool eviction are not one recoverable protocol. F23 covers a process crash after auth deletion but before this cleanup: subsequent startup explicitly skips the orphan directory. The full crash/resource leakage scenario remains unexecuted. Existing in-flight account requests admitted before deletion are not revoked by a new tombstone; no additional concrete corruption is claimed from that observation.

Executed `apps/server/src/app/multi-user.test.ts:268–341`, “deleting a bot or an account removes the workspaces,” asserts bot DELETE 204, exact removed list `[deleted]`, account DELETE 204, then exact list `[deleted, kept]` (`:322–336`). It proves successful cleanup invocation with a fake workspace, not recovery from an interrupted deletion. `server.test.ts:331–390` checks stored group history survives restart, indirectly covering restoration; it was not executed here.

<a id="group-h04"></a>

#### H04 — Account runtime acquisition and recovery — OK

`apps/server/src/app/tenant.ts:113–319` assembles resource tiers using `Layer.provideMerge`: dependencies are acquired below consumers and closed after them. The sandbox/tool layer is deliberately below bot runtime (`:288–317`), keeping tools alive while the runtime closes. `createTenant` constructs a `ManagedRuntime`, creates a private random bearer token/API, then runs account recovery before returning the tenant (`:358–398`). On construction failure it disposes the runtime before rethrowing (`:400–402`); those resources belong to Effect scopes, not an untracked Promise cancellation scheme.

`resumeAccount` recovers bots, marks old script work appropriately through that service, recovers groups, then starts gateways, relay, dispatcher and scheduler (`:348–355`). Background layer-owned work can already exist, as the source comment acknowledges; it is not correct to infer every service is dormant until `start`. Durable state belongs to the individual repositories, whereas runtime handles/tokens/closures are reconstructed. No invalid cross-tier transition was established. Account deletion calls workspace removal before disposal; an external failure there is logged by its service (`:333–345`).

Read `apps/server/src/app/server.test.ts:630–760`, “an account recovers script runs and dispatches due scripts into the bot chat”: it seeds a persisted running row, asserts it becomes `interrupted` with a finish timestamp (`:707–715`), then asserts a due run succeeds with exit code/output and the transcript contains the script origin/content (`:738–757`). Not executed here because it executes a local shell command. `tenant.test.ts:96–167` tests per-tenant Claude config/status isolation, not complete finalizer ordering.

<a id="group-h05"></a>

#### H05 — Authentication bootstrap and admin establishment — OK

`apps/server/src/app/auth.ts:240–291` creates/reuses a mode-0600 auth secret, opens SQLite with WAL/foreign keys, migrates schemas, constructs Better Auth, loads settings/invites, connects the signup gate, and runs `ensureAdmin`. The gate's uninitialized closure variables are not available to HTTP callers until `startServer` readiness finishes. On errors within initialization's try block the database is closed. File/DB configuration preceding that try is synchronous startup setup, not a concurrent account lifecycle.

`ensureAdmin` (`:52–67`) leaves an existing admin alone or promotes the oldest user when upgrading a server with users but no admin. First-user establishment occurs in the user creation before-hook (`:125–130`). Password signup transaction/connection serialization described above prevents two simultaneous empty-user observations from independently committing first admins. Startup is single-owner under the intended data-lock invariant; F05 is a violation of that outer precondition, not a second separate bootstrap finding. `ensureAdmin` does not repair zero admins until restart (relevant to F09).

Executed `apps/server/src/app/auth.test.ts:93–108`, “makes the first account admin and later ones users,” asserts exact first admin/second user roles (`:103–104`). `:110–130`, “promotes the oldest user of a server without an admin,” explicitly demotes the first in storage, reopens auth, and asserts oldest admin/second user (`:125–126`). Those exercise successful persistent recovery, not concurrent demotion. The auth secret survives restart; session cookie cache is disabled (`auth.ts:220`), avoiding stale cached role/user authorization as an assumed guarantee.

<a id="group-h06"></a>

#### H06 — Signup admission and passkey account creation — P2

The gate (`apps/server/src/app/auth.ts:86–115`) admits first user, open signup, or valid invitation. Password creation before-hook checks the current transaction adapter and consumes an invite only when otherwise closed (`:125–143`). Passkey option generation validates context/email uniqueness and current admission without consuming (`:161–178`); verified unauthenticated registration rechecks admission, consumes and creates the user (`:180–203`). Existing sessions skip account creation. Changes to signup settings between option generation and verification are therefore intentionally rechecked, not grandfathered. Raw WebAuthn challenge correctness is dependency-owned, not assumed to compensate for Crumble's admission protocol.

Ordinary web signup uses `createSession: true` (`apps/web/app/connect.tsx:117–123`); the actual passkey dependency then puts user/invite/passkey/session writes in a transaction. Reject the generic claim that every passkey verification is nontransactional. However the public verification schema permits false/omitted `createSession`, and that branch bypasses the transaction, making the invite read/update vulnerable (F22). Full valid concurrent ceremonies were not reproduced, hence P2 rather than P1.

Executed `apps/server/src/app/auth.test.ts:132–167`, “closed sign-up needs an open invite, which works once,” asserts rejection without an invite, invited user role, repeat/revoked rejection and no pending invites. This tests password signup only. Read `server.test.ts:248–271`, “offers passkey registration on localhost,” which asserts 200 and relying-party ID/name; it never verifies a passkey or tests invite spending. No actual ceremony/failure rollback assertion was found in this assigned scope.

<a id="group-h07"></a>

#### H07 — Invite-link consumption — P2

`apps/server/src/app/invites.ts:12–22` represents open/consumed/revoked using nullable timestamps and optional attribution; raw random token is returned only by creation, while SHA-256 is stored (`:26–28,48–58`). `open` checks both timestamps (`:33–44`). Consumption reads open and then updates only by ID (`:86–98`); attribution independently updates by token hash (`:101–110`). Revocation writes a timestamp and never reopens. There is no expiry policy to enforce, so absence of expiry is not a defect.

`db()` calls `getCurrentAdapter` (`:29–31`), which correctly joins password signup transactions and prevents a SQLite self-deadlock from reentering the base connection. As a result, the read/update is safe under the actual password caller's transaction. Attribution occurs after commit for password creation (dependency hook queue); a crash may leave `usedAt` set and `usedBy` absent, but the invite stays spent and no unauthorized admission follows. Open signup short-circuits consumption even if an invite is supplied; that is the explicit policy here, not evidence of reopening.

F22 identifies the nontransactional public passkey caller. The actual store reproduction additionally returned `[true,true]` from concurrent `consume(token)` on one fresh invite; this proves the primitive's limitation, not two successful end-to-end ceremonies. Executed `apps/server/src/app/auth.test.ts:132–167` asserts sequential one-use/revoked behavior and pending `[]`; no conditional-update race assertion exists. Store-level atomic consume is the appropriate invariant owner, rather than a generalized FSM rewrite.

<a id="group-h08"></a>

#### H08 — Account authorization and removal — P1

Routing obtains an actual session and replaces inbound bearer authorization with the random tenant token (`apps/server/src/app/server.ts:218–257`). Viewer links can select an account without a session only when the named account still exists, and the tenant separately validates the ticket; a signed-in foreign account is not rerouted. `apps/server/src/app/api.ts:170–190` enforces internal bearer protection. Admin middleware obtains a session and freshly reads admin membership (`apps/server/src/app/admin-api.ts:148–160`); plugin-native public admin routes are blocked at `server.ts:287–289`. This avoids treating a historical session role as the sole server-admin authority.

Role changes perform a read/count guard before a separate Better Auth update (`admin-api.ts:60–78`). F09 reproduces two authorized admins each demoting themselves: both guards see two and both updates commit, leaving zero. Plugin permissions do not supply the missing count/update transaction. Self-removal is independently rejected (`:83–86`). Removal deletes auth user/sessions before tenant cleanup (`:88–94`); F23 records the separate crash window.

Executed `apps/server/src/app/multi-user.test.ts:668–734`, “only admins reach the admin API, and the plugin's own admin routes are closed,” asserts nonadmins receive 403, plugin admin listing 404, expected roles, single-last-admin demotion 409 (`:717`), deletion 204 and old token 401 (`:724–728`). It does not issue competing role/removal operations. Other executed tests prove cross-tenant reads/writes/SSE isolation (`:62–266`), signout revocation/restart (`:445–500`), and cookie-origin restrictions (`:542–624`).

<a id="group-h09"></a>

#### H09 — Settings persistence and publication — P1

`apps/server/src/app/server-settings.ts:57–81,90–135` loads persisted rows, parses each known key separately, supplies defaults for absent keys and fails unreadable signup values closed. An update validates a merged snapshot of `current`, asynchronously writes only patch entries, replaces `current` with the captured snapshot, then synchronously notifies listeners. No arbitrary JS interleaving is possible inside the final synchronous assignment/listener iteration, but different updates genuinely overlap across adapter awaits. F11 reproduces successful disjoint updates leaving memory stale while storage contains both new values.

Database rows are durable; `current` and subscription sets are transient. Restart reloads rows and can visibly change effective settings compared with the preceding successful responses. A multikey patch also has a prefix-write failure/crash window before memory replacement because no surrounding transaction is used; the identified atomicity boundary covers this, without claiming an executed disk fault. Throwing listeners could prevent subsequent listeners/HTTP success after commit, but no throwing production subscriber was established (no extra finding).

Executed `apps/server/src/app/auth.test.ts:44–68`, “one stored setting that no longer validates keeps sign-up closed,” asserts the full reconstructed fallback settings after reopening. `:70–91`, “a stored sign-up setting that no longer validates reads as closed,” asserts false after invalid JSON. Executed `multi-user.test.ts:626–666` asserts invalid CPU 400 with contract details, malformed JSON 400 and oversized input 413. None asserts concurrent storage/memory agreement or all-or-nothing persistence/publication.

<a id="group-h10"></a>

#### H10 — Account encryption-key migration — OK

`apps/server/src/shared/secret-box.ts:191–240` selects plain/wrapped/new account-key state from file presence, master-key availability and encrypted-table row counts. Wrapped-without-master, incompatible master, missing keys with encrypted rows and mismatching interrupted-migration files refuse startup rather than overwrite usable data. Wrapped migration writes an exclusive temporary file, syncs contents, renames and syncs the directory (`:88–106`), unwrap-verifies (`:144–156`), then removes/syncs the plain file (`:122–125,160–173`). Both files after a crash are accepted only when their decoded keys agree (`:129–141`). Synchronous filesystem steps do not admit ordinary Promise cancellation between operations; process/power failure is the durability concern. Random leftover temporary files after abrupt process death are not selected as keys.

`apps/server/src/app/product-layer.ts:39–53` supplies the encrypted table inventory to the missing-key guard. Outer tenant/data ownership is required; no new per-key lock is justified independently of F05. Malformed plain-key lengths fail during encryption rather than being silently replaced, but no reachable migration truncation producing such a file was found.

Executed `apps/server/src/shared/secret-box.test.ts:62–146`: tests assert exact plain/wrapped file combinations, decryption across reopen/migration, no temporary files after success (`:84–89`), injected fsync failure retains plain and later recovers old ciphertext (`:92–115`), wrong master retains byte-identical wrapped content (`:117–129`), missing/invalid master rejection (`:131–146`). These do not test actual power loss or disagreeing dual files. `product-layer.test.ts:5–30` is a lexical encrypted-table coverage heuristic, not runtime missing-key recovery proof; read only.

<a id="group-h11"></a>

#### H11 — SSE connection lifetime — OK (inspected helper/caller paths)

`apps/server/src/shared/event-stream.ts:26–64` installs an abort subscriber and creates a completion promise before awaiting setup. Callers register unsubscribe/watch cleanup during setup; both setup error and normal completion drain cleanup. After setup, a 15-second heartbeat interval exists until finish, and `finally` clears it. An early abort resolves `finished` even while setup is pending; when setup eventually finishes, registered resources are cleaned. An indefinitely blocked setup would delay cleanup, but a reachable unbounded setup was not established. Cleanups run serially; failure of one could skip later callbacks, but no demonstrated failing cleanup supports a separate finding.

`snapshotSender` (`:17–24`) sends a fresh JSON snapshot, not an ID-based replay. Chat/group callers subscribe before initial snapshot/watch (`apps/server/src/bots/chat-api.ts:122–134`, `group-chats/group-chats-api.ts:90–104`). Dependency qualification: Hono's `HONO/utils/stream.js:37–43` swallows transport write failures; `.catch(finish)` is not a reliable detector of socket loss itself. Actual body cancellation invokes `abort()` and all subscribers (`:31–35,77–88`), which is the real cleanup path; do not claim heartbeat rejection alone guarantees disconnect detection.

Executed `apps/server/src/app/multi-user.test.ts:249–261` asserts SSE 200/content type and an initial snapshot, then cancels; it does not assert cleanup counts. Read-only `api.test.ts:712–745` asserts activity content/agent ID and immediate heartbeat within one second; `:747–778` asserts preview replay content. `:624–659` asserts bounded options forwarded to watch, not watch disposal. Dedicated cleanup/racing-abort assertions were not found.

<a id="group-h12"></a>

#### H12 — Shared coordination and timer gates — OK

`apps/server/src/shared/keyed.ts:3–22` maps keys to listener sets, returning removal closures that remove empty sets; notification is synchronous. `:24–33` lazily stores one semaphore per key; lookup/create/store is synchronous, so competing fibers do not create different same-key locks at an await boundary. The map retains locks for the runtime lifetime; memory growth is a possible maintenance concern, not a demonstrated correctness failure. Actual users are bot opening and group context admission (`bots/bots-context.ts:52–55`, `group-chats/group-chat-context.ts:66–70`). Removing a listener twice normally deletes nothing further; no production misuse violating listener-generation ownership was found.

`apps/server/src/shared/ticker.ts:5–15` updates its hourly deadline before pruning, so a failed prune waits until the next hour (rather than retrying every tick). The chosen semantics are not evidence of incorrect data retention. `:18–33` closes over `started`, sets it before forking, forks into the owner scope, catches defects per tick and sleeps; running the same returned effect twice does not start two loops. Scope shutdown owns interruption. Each new service instance gets a fresh gate on restart.

`apps/server/src/app/job-wiring.ts:7–12,25–59` acquires unsubscribe arrays and releases them with scope finalization; relay errors are caught/logged. Executed `shared/ticker.test.ts:5–25`, “a tick that dies leaves the loop running,” throws on the first tick and asserts `ticks > 1`; this is a real liveness assertion, but does not test duplicate start or post-scope inactivity. No dedicated keyed/job-wiring lifetime assertions were found. No shared FSM abstraction is warranted by this review.

### Local findings

<a id="finding-f05"></a>

#### F05 — P1, high confidence, reproduced — Nonatomic directory ownership permits two successful ownership claims (H02)

**Location:** `apps/server/src/app/data-lock.ts:49–60` (read/check/write); public entry `apps/server/src/app/server.ts:346–360`.

**Minimal sequence/preconditions:** Two independent processes start with the same data directory and no live owner (a stale record is also sufficient). A reads absent/stale. Before A writes, B reads the same absent/stale record. Each passes `othersAlive`, writes its own PID with ordinary truncating `writeFileSync`, adds its own process-local held entry and returns success. Nothing later verifies exclusive ownership. This is reachable through concurrent `startServer`/CLI startup; no credentials, async JS reentrancy or database corruption are required.

**Invariant/outcome:** Exactly one process may own a product data directory. Both return a successful ownership claim. If configured listener ports permit both startups to continue, both can initialize auth databases and tenant runtimes against the same files. Distinct supported ports are therefore an additional precondition for the full two-server consequence; the reproduction does not exercise full startup. Concurrent workspace automation and durable runtime writers would violate their intended single-owner precondition. The reproduced outcome is two successful lock acquisitions, not reproduced duplicate bot work or database corruption. Severity P1 reflects meaningful operational integrity risk; likelihood depends on overlapping startup/deployment, blast radius is that entire data directory. Release's matching-PID guard does not restore exclusivity. Restart after one owner exits does not undo duplicate execution or conflicting writes.

**Evidence:** `bun /tmp/crumble-state-review-d5de813/repro-lock.ts` gated each child's real ownership write after real owner checks, then released both: `a acquired 72578`, `b acquired 72579`, both exit 0. Gate injection only schedules OS-process interleaving at an existing seam. Test gap is the same-process/stale-PID coverage at `server.test.ts:108–127,160–177`.

**Regression proposal / boundary:** Keep this two-child gate test; expected exactly one success and one `DataDirLocked`, actual both success. Introduce an actual OS/advisory-lock or carefully atomic ownership claim with stale takeover semantics. Simply changing the final write to exclusive-create without defining stale-record reclamation is incomplete. The invariant belongs to `lockDataDir`, not each tenant.

<a id="finding-f09"></a>

#### F09 — P1, high confidence, reproduced — Competing guarded demotions leave zero admins (H08)

**Location:** `apps/server/src/app/admin-api.ts:60–78`; recovery `apps/server/src/app/auth.ts:52–67,265`. Dependency `BA/plugins/admin/routes.mjs:44–78` has no cross-request admin-count transaction.

**Minimal sequence/preconditions:** Exactly two users A/B are admins, each with a valid session. Concurrent PATCH `/v1/admin/users/A` by A and `/v1/admin/users/B` by B both request `{role:"user"}`. Fresh admin middleware admits both. Each `findUser` sees an admin and `adminCount` sees two before either plugin update. Both plugin permission checks can also read the current admin before either update, then each demotion succeeds. This uses allowed self-demotion, not forbidden self-removal. Public Hono routes have no serializing wrapper.

**Invariant/outcome:** The server claims it must retain at least one admin. Actual real app reproduction yielded `parallel demote [200,200] admins 0`. Until restart, all admin APIs are inaccessible; the oldest user is promoted on restart, which can also give a different former user admin authority than intended. This requires two authorized admin actions, so it is not an unauthenticated exploit, but it can arise from concurrent UI/administration and affects all users' administrative operations. Retry cannot repair it as neither former admin remains authorized. No crash is required.

**Experiment:** `bun /tmp/crumble-state-review-d5de813/repro-auth.ts`, real `createAuth`, SQLite and `adminAPI`; second user's setup promotion uses the actual adapter, then requests use real bearer sessions/route/plugin code. Reproduced twice. Existing `multi-user.test.ts:668–734` only checks demotion when already at one admin, especially `:717`'s 409.

**Regression proposal / boundary:** At the real adapter count seam, defer both post-count returns until two demotions have observed two; then release and assert at most one 200, at least one conflict, persisted admin count at least one. Serialize/check-and-write role changes and removals under one invariant-owning boundary, rechecking authorization/count inside it. Only serializing individual SQL calls is demonstrably insufficient.

<a id="finding-f11"></a>

#### F11 — P1, high confidence, reproduced — Successful concurrent settings updates lose each other's in-memory state (H09)

**Location:** `apps/server/src/app/server-settings.ts:103–126`; public route `apps/server/src/app/admin-api.ts:139–141`.

**Minimal sequence/preconditions:** Existing settings CPU=2 and memory=4096 (preexisting rows suffice). Start `update({workspaceCpus:8})` and `update({workspaceMemoryMib:8192})` concurrently. Both capture `next` from the same old `current` before adapter awaits. Each persists its distinct patch. Each publishes its own stale merged object. The last assignment hides one successful update. The public PATCH route directly awaits this method, with no request-level semaphore/transaction.

**Invariant/outcome:** Published settings must correspond to the accepted durable configuration; independent successful patches must compose. Actual result: first return CPU=8/memory=4096, second return CPU=2/memory=8192; final memory CPU=2/memory=8192, database rows CPU=`8`, memory=`8192`. Restart makes CPU jump back to 8. For signup policy a concurrent unrelated patch can similarly overwrite a newly closed in-memory policy from its stale snapshot, so the impact is not just a misleading form. No listener exception, disk error or external credential is required. Blast radius is all tenants reading the shared store; concurrency requires authorized admins/settings clients. Retrying the apparently missing value may repair it but does not establish a reliable protocol.

**Experiment:** `bun /tmp/crumble-state-review-d5de813/repro-auth.ts` invokes the unmodified real store with actual SQLite and logs rows, responses and `get()`. Reproduced twice. Existing `auth.test.ts:44–91` tests decoding/restart fallback, and `multi-user.test.ts:626–666` tests validation, not concurrent publication.

**Regression proposal / boundary:** Use the real SQLite-backed store with a deferred adapter method after capturing the first patch; issue a second disjoint patch and release in both orders. Assert both final `get()` and a freshly opened store contain both changes, and subscriber snapshots follow accepted commit order. Serialize full read/validate/persist/publish operations; also transact all rows of one patch so a partial database failure cannot leave a prefix applied while memory stays old. This is one concrete settings consistency boundary, not a generic state-machine framework request.

<a id="finding-f22"></a>

#### F22 — P2, medium-high confidence in public composition; store race reproduced — Passkey registration can bypass transaction protecting one-use invites (H06/H07)

**Location:** `apps/server/src/app/auth.ts:180–203`; `apps/server/src/app/invites.ts:86–98`. Public dependency schema/branch `PK/index.mjs:305–308,362–423`; web's safer choice `apps/web/app/connect.tsx:117–123`.

**Minimal candidate sequence/preconditions:** Server already has a user and signup is closed. Obtain one open invitation and generate two unauthenticated passkey registration option sets for distinct unused emails using it; both initial `inviteOpen` checks succeed. Complete two valid, distinct WebAuthn ceremonies concurrently, posting verification bodies with `createSession:false` or omitted. The dependency executes `persistRegistration` without `runWithTransaction`. Both `mayJoin` calls see existing users/closed signup and reach `consume`. Both read the invite open before either usedAt update; both return true and proceed to user/passkey creation. SQLite's mutex serializes individual statements, which does not preclude both reads preceding the writes.

**Invariant/outcome:** One invite should admit one account. The store-level actual repro on a fresh token returned `nontransactional consume [true,true]`; a control with concurrent **password** signup returned one fulfilled and one `APIError: Sign-up is closed`. Thus the primitive race is proven and the dependency's unprotected public branch is real, but no full valid concurrent WebAuthn ceremonies were executed. This is deliberately P2, not an assertion that an end-to-end exploit was reproduced. The bundled web sends true, reducing ordinary-user likelihood, but a custom unauthenticated API caller is not constrained to the web's option. Potential blast radius is extra accounts created from the shared token; no restart repairs extra users.

**Test gap / deterministic proposal:** `auth.test.ts:132–167` tests only password consumption and `server.test.ts:248–271` only generated options. Exercise real `/passkey/verify-registration` with valid signed software-authenticator response fixtures and distinct challenges/credentials, both with false. Gate the actual invite store's open reads so both complete before updates, then require only one persisted new user and one consumed invitation. Also inject passkey-insert failure with false to check no admitted orphan account/consumed invite survives. The test requires real verification fixtures; calling a mock verification callback is not end-to-end proof. Make consumption a conditional atomic claim and always transact unauthenticated account+passkey creation regardless of session issuance.

<a id="finding-f23"></a>

#### F23 — P2, medium confidence, source-traced crash window, not reproduced — Interrupted account removal is not resumed after auth deletion (H03/H08)

**Location:** `apps/server/src/app/admin-api.ts:82–94`; `apps/server/src/app/server.ts:139–153,197–208`; `apps/server/src/app/tenant.ts:333–345`.

**Minimal candidate sequence/preconditions:** An account has durable account files and preferably a running externally hosted workspace. An admin removes it through DELETE `/v1/admin/users/:id`. Better Auth deletes its sessions/user successfully. The process dies before `options.removeAccount(id)` finishes workspace/runtime/file cleanup (or before it begins). On restart, `restoreTenants` sees the directory but `accounts.hasUser` is false, so skips it. Repeating the public DELETE fails at `findUser` with 404, before cleanup. There is no persisted deletion queue or orphan cleanup scan in the inspected bootstrap path.

**Invariant/outcome:** Administrative account removal should have a recoverable path to releasing the account's durable/external resources. Source proves the auth/cleanup gap and restart exclusion; retained directory and workspace lifetime after an actual crash were not measured, so P2. Access is revoked correctly (this is not a demonstrated old-session auth bypass). Files can remain indefinitely; an external workspace may keep costing resources depending on provider behavior, which was not audited here. Ordinary successful removal is tested and correct. A failed/crashed DELETE need not have returned 204 to expose the problem: the user now cannot retry cleanup through the same public operation.

**Test gap / deterministic proposal:** `multi-user.test.ts:268–341` asserts exact successful fake workspace removals, with no interruption. In a hermetic child server, use an injected fake workspace whose remove call records entry then blocks; remove an account, wait until its auth row is absent, SIGKILL, reopen the same data directory with the fake provider and verify eventual cleanup marker plus directory removal. A less expensive source-boundary test can fail the injected admin `removeAccount` callback after auth deletion and show the retry never calls it, but that is not a full startup recovery test. Persist a deletion tombstone/work item before deleting the auth row and resume it independently of normal live-user restoration. Avoid scanning/deleting arbitrary unknown directories without defining ownership and encrypted-data recovery expectations.

### Boundaries and remaining limits

Only demonstrated invariant owners justify new shared boundaries: atomic directory ownership (F05), serialized/transactional last-admin mutation (F09), transactional ordered settings publication (F11), atomic invite claim plus unconditional signup persistence transaction (F22), and resumable deletion intent (F23). Existing Effect scopes, per-key semaphores, named reconnect operations and WebAuthn transaction support should be retained rather than replaced aesthetically.

No feature lifecycle or frontend state-machine audit was performed beyond required caller traces. Full passkey ceremonies, true process/power-loss encryption migration, interrupted removal, construction-failure tier finalization, and exact SSE cleanup callback counts remain unexecuted. The inspected helper paths did not establish additional correctness defects. Repository status after work remained the preexisting untracked `docs/implicit-state-machines.md` only.

<a id="jobs-workspaces-review"></a>

## Jobs and workspace recovery

### Scope and verdict

Reviewed **J01–J09: nine groups**. Findings: **two P1 findings, zero P0, zero P2, zero P3**. Group classifications: J02/J04 share finding F14; J05 has finding F15; J01/J03/J06/J07/J08/J09 are OK within the inspected scope. Do not count the shared finding twice.

The requested baseline resolves to `d5de8135f8c1acfab803f84ab4d99cef3613cc4d`. The checkout is `95570dd0519ca22b8a3361b26af8e23c59f687a0`; `git diff d5de813 HEAD --stat -- apps/server/src/jobs apps/server/src/workspaces` is empty. The reviewed implementations and tests in those directories therefore match the baseline. The reproduction uses checkout `AgentRuntime`; its baseline diff only removes the optional partial-reply snapshot option and associated import, not job admission, tools, documents, or completion. This does not affect either reproduced path. The pre-existing untracked inventory was not edited. Read the complete brief, repository instructions, glossary, inventory, and Railway ADR `docs/adr/0005-railway-workspaces.md`. No repository edits or mutations were performed.

Repository references in this report are relative to `/Users/leonhardbreuer/Developer/crumble-project/bot`. Dependency references use `apps/server/node_modules/@earendil-works/pi-durable`, resolving to installed version 1.4.0. Dependency semantics were inspected, not inferred from the inventory.

### Executed checks

Executed the existing tests, with real backends disabled:

```sh
CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun test apps/server/src/jobs/jobs.test.ts apps/server/src/jobs/jobs-queue.test.ts apps/server/src/jobs/jobs-stop.test.ts apps/server/src/jobs/jobs-status.test.ts apps/server/src/jobs/jobs-parallel.test.ts apps/server/src/jobs/coding.test.ts apps/server/src/workspaces/machine-workspaces.test.ts apps/server/src/workspaces/microsandbox-workspaces.test.ts apps/server/src/workspaces/railway/railway-workspaces.test.ts
```

Result: **43 pass, 76 skip, 0 fail; 170 assertions; 9.16 seconds**. Skips include VM, real Railway, and generated environment-conformance cases. No VM, emulator, credentials, or external service was used.

Also executed:

```sh
bun test /tmp/crumble-state-review-d5de813/jobs-repro.test.ts
```

Result: **1 pass, 0 fail, 4 assertions; 439 ms**. The parent independently reran this same throwaway test and confirmed both observed behaviors: **1 pass, 4 assertions**, using the unmodified runtime. The invariant-to-severity assessment remains based on the source contracts: grace is explicitly intended to follow a question, and stop must end that job's contribution to unfinished work. This throwaway test calls the unmodified `codingPlugin` and `AgentRuntime`, the real pi-durable scheduler, and real job documents. Its model and workspace boundary are hermetic test doubles. It does not reimplement the protocol. It records both defects through the normal model tool path. The assertions intentionally confirm actual defective behavior, not desired behavior. Output:

```text
GRACE_AFTER_QUESTION ["acquired","released"]
TURN_BEFORE_STOP {"open":true,"reports":[]}
TURN_AFTER_STOP {"open":true,"reports":[]}
JOB_AFTER_STOP ... "status":"idle" ... "question":{"text":"Which color?", ...}
```

### Per-group analysis

<a id="group-j01"></a>

#### J01 — Job delivery, reporting, and announcement: OK

`apps/server/src/jobs/jobs.ts:160–169` represents the reporter as `wait`, `deliver`, `report`, and `announce`. Queue creation atomically creates the background reporter, delivery membership, and originating-turn work (`:976–1000`). The wait transaction validates the stop generation and claims an exclusive holder with the phase checkpoint (`:404–475`). Admission marks `submitting` (`:479–515`); job submission uses a stable request identity, clears delivery membership after admission, waits for settlement, and checkpoints the report (`:546–635`). Report submission has a separate stable identity (`:735–770`). Turn closure and the announcement checkpoint share a transaction (`:818–829`).

Rejected hypothesis: a crash after claiming exclusivity but before checkpointing can increment the holder twice. The holder update and phase transition are one `runtime.commit`; installed pi-durable commits document changes and returned task state together (`dist/harness/scheduler.js:1989–2003`). Reported answer IDs and report payloads likewise commit together. Announcements intentionally remain at-least-once, with stable event IDs (`jobs.ts:833–853`); this is not an exact-once subscriber contract. Finished callbacks are transient and run after the report checkpoint, unlike durable report delivery.

`apps/server/src/jobs/coding.test.ts:263` asserts report content, exactly one transcript report, files, and sync calls. Its `:688` restart test checks one report after reopening persisted runtime state. `jobs.test.ts:10` and `jobs-queue.test.ts:10` assert exclusive ordering. These passed. They do not cover every crash point; no impossible replay window is claimed.

<a id="group-j02"></a>

#### J02 — Job stop versus admission: P1, shared finding F14

`apps/server/src/jobs/jobs.ts:947–974` increments the persisted stop generation, polls submitting deliveries, and aborts the reusable job conversation. Older waiting deliveries fail `deliveryTarget` (`:404–421`); admitted deliveries carry `submitting` until `job.submit` completes (`:479–515`, `:594–613`). Working status derives from delivery membership or a live run (`:241–245`), not a permanent stopped state. A later send deliberately captures the new generation and reuses the job.

Rejected hypothesis: merely delaying submission's storage commit beyond ten seconds necessarily admits work after stop. pi-durable submission admission uses the Session mutation line (`dist/harness/submissions.js:36–53`), and conversation abort uses that same line (`dist/harness/scheduler.js:416–438`). A blocked admission already enqueued there also blocks the subsequent abort; an arbitrary timing diagram that ignores that serialization is not proof.

The actual reachable defect is stopping an already-posted question. Its reporter has terminated normally, so conversation abort has nothing left to cancel. Stop never clears the pending question or closes its originating turn. The real-runtime reproduction returns from stop while `turnWork` remains open. This persists across ordinary document recovery; a later answer or send can resolve it, but restart alone cannot.

`apps/server/src/jobs/jobs-stop.test.ts:10`, “stopping a waiting job cancels its delivery,” checks that only job `a` starts after stopping queued `b`. It passed but never reaches the question-wait state.

<a id="group-j03"></a>

#### J03 — Job question and answer race: OK, except the J02 stop boundary

A job question starts as a persisted `Question.pending` with a random identity (`apps/server/src/jobs/jobs.ts:1462–1515`). The tool terminates the turn. When the submission settles, `postQuestion` atomically sets `posted`, records originating turn/reporter identity, appends the owner-visible card, and checkpoints the reporter's question payload (`:546–585`, `:666–703`). Only posted questions appear in ordinary listing (`:1220–1233`). Listener delivery can repeat after restart and carries the same question identity (`:783–790`).

Answers use one harness transaction to compare identity, clear the pending question, queue a new reporter, and replace the old open-work marker (`:1526–1560`, `:976–1000`). Therefore owner and reporter cannot both accept the same question. This guard is based on current document state, not a prior HTTP snapshot. Ordinary sends clear previous questions and close their tracked work in the same delivery transaction (`:1029–1085`). A stale answer then returns false. No cross-agent delegation internals were audited beyond this boundary.

`apps/server/src/jobs/coding.test.ts:930`, “a job's question waits through a restart, and the owner's answer resumes the job,” asserts one question card, no premature report, persisted options, HTTP 409 for an older identity, HTTP 204 for the current identity, question disappearance, and the resumed report. It passed. It does not exercise simultaneous owner/reporter calls; single-winner behavior is source-proven by the serialized transaction.

<a id="group-j04"></a>

#### J04 — Composite turn completion: P1, shared finding F14

`apps/server/src/jobs/jobs.ts:204–237` tracks each originating turn with open reporter IDs, report submission IDs, and the first error. An answered question replaces the old open reporter instead of briefly declaring completion (`:1526–1560`). Report settlement closes its reporter and retains its report submission (`:799–829`). Questions intentionally keep work open after their reporters end (`:792–797`). Settled-only pruning (`:195–202`) does not evict active work, and `turnWork` matches merged input identities (`:1573–1593`).

This is durable document state, not a transient listener count. Normal runtime shutdown and recovery preserve open questions and associated work. The defect is that stop only addresses the execution layer; after a question reporter ends, no remaining task owns cleanup of its open marker. Consequently the composite result stays running despite stop succeeding. The consumer boundary is material: `apps/server/src/bot-messaging/bot-messaging.ts:85–95` prioritizes `work.open` over terminal execution status; `:307–327` continues waiting while it is open. This is boundary tracing, not a separate delegation audit.

`apps/server/src/jobs/coding.test.ts:993`, “a job keeps the bot turn that sent its work through a restart, until its report is answered,” asserts `open: true` after restart, then `open: false`, one report ID, and the bot response after answering. It passed. It establishes that a question intentionally owns durable completion, but omits the stop transition reproduced here.

<a id="group-j05"></a>

#### J05 — Question grace hold: P1, finding F15

`apps/server/src/jobs/coding.ts:74–101` stores one workspace-level release closure and timer. Asking releases a previous hold, acquires `keepAwake`, and schedules expiration using the configured grace period. `wake` clears the timer and releases exactly the stored hold. File-changing tool completion synchronizes (`:64–71`); the job extension's `afterTool` hook also calls `wake` (`:130–140`). Extension caching (`:194–226`) correctly preserves the closure across rebuilds. The hold is intentionally transient and does not survive process restart.

The invalid transition is not a timer race: the same `ask_owner` call immediately triggers its own `afterTool`, which releases the hold it just created. Installed pi-durable runs `afterTool` for a successful tool result before applying terminal control (`dist/harness/tool.js:431–444`). The actual runtime reproduction records acquisition followed by release before the question is available to the owner, despite a 900,000 ms grace setting. Thus the configured grace does not extend workspace lifetime; normal idle stop can lose running services before the owner answers. Release idempotence does not repair an early release.

`apps/server/src/jobs/coding.test.ts:332`, “a bot's extensions are built once, so a later turn can still wake what a question held,” checks only extension object identity. It passed but never asks a question or asserts hold lifetime. The question tests use a no-op `keepAwake` (`:115–117`), so their successful question assertions cannot expose this defect.

<a id="group-j06"></a>

#### J06 — Shared workspace lifetime: OK

`apps/server/src/workspaces/machine-workspaces.ts:288–326` combines optional `running`, in-flight request count, hold count, timer, and a semaphore. `TrackedConnection` wraps request/info/session with balanced activity accounting (`:251–286`). Boot and stop use the same permit and run the protected operation uninterruptibly (`:324–326`, `:390–408`). Idle teardown rechecks activity and holds after acquiring the permit. Hold release is idempotent (`:411–424`). The idle timer is armed only when running without activity or holds (`:532–547`).

Restart preserves the reconnectable connection; final forced stop closes it (`:398–400`, `:648–651`). Teardown withdraws the current instance before closing relay and stopping the backend (`:549–561`). A stop failure is surfaced; Railway can reconnect using its persisted identity rather than silently destroying unsaved state. Close sets the owner flag before taking the workspace snapshot, and boot checks it (`:672–699`); pending boots already in the map serialize with their stop. New workspaces cannot boot after closure. In-memory holds/activity/timers reset after process crash, while provider-specific recovery owns persisted machines.

`apps/server/src/workspaces/machine-workspaces.test.ts:75` asserts stop-before-remove, `:148` verifies passive observation does not retain a released machine, and `:181` verifies no boot after close. All passed. These tests do not prove every concurrent start/close ordering; the semaphore/closed checks were traced statically.

<a id="group-j07"></a>

#### J07 — Desktop readiness and stream holds: OK

Display-only callers boot and return before browser readiness; normal connection callers join the shared readiness fiber (`apps/server/src/workspaces/machine-workspaces.ts:328–348`, `:713`). A readiness failure tears down only if the captured running object is still current (`:338–344`), preventing an obsolete completion from stopping a replacement. Image/permission checks precede desktop access (`:427–447`), and connection rechecks the returned image after boot (`:505–514`). Active streams acquire a hold before boot, release it on acquisition failure, and return an idempotent hold-release path through close (`:453–475`, `:497–529`). Passive streams neither boot nor hold and fail if no desktop is running (`:458–464`, `:484–494`).

Rejected hypothesis: arbitrary cancellation of a normal workspace tool must tear down another caller's readiness wait. Normal pi-env command acquisition uses `Effect.runPromise(this.ensureStarted())` without a caller abort signal (`:304`); that claimed interleaving is not established through this public path. Display callers intentionally do not join browser readiness. Desktop control authority itself is outside this partition.

`apps/server/src/workspaces/machine-workspaces.test.ts:131` asserts stream-open failure releases the idle hold; `:148` asserts passive observation neither boots nor prevents stop. Both passed. The test at `:114` simulates failure inside backend boot, not a failure of the detached readiness fiber after display availability. That is a coverage limitation, not evidence of a defect.

<a id="group-j08"></a>

#### J08 — Microsandbox resume versus replacement: OK

`apps/server/src/workspaces/microsandbox-workspaces.ts:125–144` ensures the named persistent volume, resumes or creates a machine, then prepares the guest. Resume stops a machine left running by a dead server before starting it (`:437–447`). Compatibility requires image, network policy version, CPU, memory, and reclaiming the recorded proxy port (`:200–229`). Otherwise replacement stops the resumed machine, creates a new proxy and sandbox, and mounts the same volume (`:231–278`). Machine metadata is written and flushed before successful return (`:271–275`).

Acquisitions use `untilBooted` (`apps/server/src/workspaces/machine-workspaces.ts:196–204`) under the boot scope, so a later boot failure closes acquired proxies and stops acquired sandboxes. Normal stop flushes a live machine and always attempts sandbox stop and proxy close, even if flushing fails (`microsandbox-workspaces.ts:319–335`). Persistent files are volume-backed; transient processes, proxy listeners, and running-object references are reconstructed. An incompatible root disk can be discarded by design; this is not loss of the persistent workspace. Actual provider behavior was not exercised.

`apps/server/src/workspaces/microsandbox-workspaces.test.ts:104` asserts stop/remove/volume ordering; `:139` asserts an unrelated lookup failure leaves the volume untouched. These passed. Gated tests at `:197`, `:214`, `:251`, and `:382` assert file retention, crash takeover, root-disk preservation on compatible resume, and network-policy replacement respectively. Their assertions were inspected, but they were skipped because VM startup is forbidden for this review.

<a id="group-j09"></a>

#### J09 — Railway recovery, checkpoints, and liveness: OK within inspected scope

`apps/server/src/workspaces/railway/railway-workspaces.ts:307–343` reconnects by recorded sandbox identity, preserves errors other than confirmed absence, and checkpoints an incompatible live image before destroying it. Creation restores a matching checkpoint or builds a template and copies `/workspace`; migration checkpoints the new disk before recording its image (`:394–449`). Metadata uses a temporary file and rename (`:473–479`). Runtime state combines stopped, heartbeat, tunnel, stream queues, checkpoint timer, and a promise tail (`:482–524`). Checkpoints serialize despite an earlier rejection (`:668–675`).

Sync deliberately debounces for 30 seconds (`:626–640`). Stop disables heartbeat/tunnel activity, waits for checkpoint success if alive, and only then destroys (`:646–664`). A failed liveness request is not confirmed absence (`:570–580`), preserving reconnectable state. Heartbeat ends streams on confirmed destruction, but tolerates unknown state (`:528–544`). Tunnel restart is stopped-guarded (`:506–524`). These are deliberate transient versus persistent boundaries. Per ADR 0005, server-plus-sandbox loss before checkpoint, debounce, and absent network policy are accepted tradeoffs, not findings. No exact-once external checkpoint claim is made.

`apps/server/src/workspaces/railway/railway-workspaces.test.ts:202` asserts unreachable liveness does not destroy; `:260` asserts reconnect failure neither creates a replacement nor rewrites identity. Both passed. Gated tests at `:521`, `:540`, `:571`, and `:619` inspect checkpoint restoration, same-ID server recovery, post-loss restoration, and image migration. They were not executed. No live-provider, crash-between-provider-commit-and-local-rename, or storage-fsync experiment was performed.

### Findings

<a id="finding-f14"></a>

#### F14 — P1 — Stopping a question-waiting job never settles its originating turn

**Confidence:** high; **reproduced** through unmodified production runtime. **Affected IDs:** J02 and J04; J03 supplies the question state boundary.

**References:** `apps/server/src/jobs/jobs.ts:947–974` (stop), `:666–703` (question records originating reporter), `:792–797` (question reporter terminates without closing work), `:1029–1041` (cleanup available to send but not stop), `:1526–1560` (answer replaces question work). Consumer: `apps/server/src/bot-messaging/bot-messaging.ts:85–95`, `:307–327`.

**Minimal sequence and preconditions:**

1. Start a coding job from a bot turn, producing an originating submission identity.
2. Let the job call `ask_owner`, complete its turn, and publish its question. The question reporter completes, while the originating turn retains that reporter ID as open work.
3. In the same bot's chat, call `coding` with `action: "stop"` and the job name.
4. Observe that stop returns, the job is idle, but the original turn is still `open: true` and the question remains answerable.

The reproduction executes all these steps; no scheduling race or crash is necessary. The violated invariant is that an explicitly stopped job must cease contributing unfinished work to the originating turn. Aborting an idle child conversation cannot clean a background reporter that already terminated. The job record and open-work marker are durable; a restart reloads them, so restart alone does not heal the state. An answer or ordinary send can replace/clear it, which is a workaround, not stop semantics.

**Impact:** a delegated task can remain `running` indefinitely after the assignee says it stopped the job. Waiters time out repeatedly, and the owner retains a misleading actionable question. Ordinary chat jobs also retain the question. Blast radius is the originating work for that job, not account-wide loss. This is a meaningful user-visible correctness bug, not a security issue.

**Existing-test gap:** `apps/server/src/jobs/jobs-stop.test.ts:10` stops a delivery waiting for exclusivity. `apps/server/src/jobs/coding.test.ts:993` tests question completion only through answering. Neither checks stopping a posted question.

**Deterministic regression proposal:** reuse the actual runtime/faux-model seam in `coding.test.ts`. Gate on a posted question and the originating turn's open marker, then issue stop and await its tool result. Assert the pending question is absent and originating work is closed with a stopped error. Reopen the runtime from the same directory and repeat those assertions. Actual current outcome is a surviving question and `open: true`; the included throwaway test confirms this without repository edits. Own cleanup in the same jobs-document transaction that advances the stop generation, closing question-held work and invalidating that question atomically. Do not attempt to solve this in the delegation waiter.

<a id="finding-f15"></a>

#### F15 — P1 — A question releases its own configured workspace grace hold

**Confidence:** high; **reproduced** through unmodified production runtime. **Affected ID:** J05; J06 correctly honors the release it receives.

**References:** `apps/server/src/jobs/coding.ts:74–101` (hold acquisition and timer), `:130–140` (unconditional job `afterTool` wake), `apps/server/src/jobs/jobs.ts:1490–1515` (ask callback and termination result). Installed dependency: `apps/server/node_modules/@earendil-works/pi-durable/dist/harness/tool.js:431–444` (tool result processing invokes `afterTool`). Idle eligibility: `apps/server/src/workspaces/machine-workspaces.ts:411–424`, `:532–547`.

**Minimal sequence and preconditions:**

1. Enable coding jobs with a nonzero question grace period; the reproduction sets 900,000 ms.
2. Let a coding job execute `ask_owner`.
3. Its callback acquires `keepAwake` and installs the grace timer.
4. pi-durable processes the same successful tool result through the job extension's `afterTool`; unconditional `wake()` clears the timer and releases the new hold immediately.

The reproduction's workspace spy records `["acquired","released"]` before it observes the posted question. This is the real runtime's call order, not a mocked scheduler or speculative interleaving. It violates the invariant that asking retains the workspace until grace expiration or a subsequent wake/tool completion. No later tool or owner answer occurred.

**Impact:** the question grace setting is ineffective. Once other activity and holds cease, ordinary idle stop can stop servers or desktop state while the job waits for its owner. The reproduction proves the premature release, not an actual VM shutdown; the shared workspace's idle-eligibility check establishes that consequence when idle timeout precedes the configured grace. Other active holds can mask the defect. Impact is per bot workspace; there is no credential exposure or durable-file corruption claim. Restart cannot restore the transient timer and is not a remedy.

**Existing-test gap:** `apps/server/src/jobs/coding.test.ts:332` asserts cached extension identity only. Its `DirectoryWorkspaces.keepAwake` at `:115–117` is a no-op, so question tests cannot assert grace behavior.

**Deterministic regression proposal:** spy on `keepAwake` through the real `codingPlugin` and `AgentRuntime`. Gate on the question card after `ask_owner` finishes; assert one acquisition and zero releases without waiting for wall-clock grace. Answer the question and let the job execute a later tool; assert exactly one release. Separately use a short controlled timer to assert expiration and no double release. Current outcome is immediate release, reproduced by the included test. The smallest ownership correction is to exclude the asking tool itself from the wake transition, preserving wake for subsequent job tool completion. No generic state-machine framework is needed.

### Limits and rejected overclaims

- All nine requested groups have implementation and assertion analysis. Desktop authority, secret caching, and delegation routing were not independently audited.
- No whole-project lint/typecheck was run; this was a read-only protocol review rather than an implementation change.
- Existing restart tests use runtime shutdown/reopen; they are not equivalent to every abrupt process-crash window.
- Backend test doubles prove local orchestration, not provider durability. VM and Railway integration assertions were read but not executed.
- No claim is made that stable event IDs provide exactly-once side effects. Announcement replay remains permitted.
- No finding is raised for the accepted Railway debounce/network policy or simultaneous server/sandbox failure tradeoffs.
- Narrow provider/local-record crash windows were statically considered but not reproduced. They are not promoted to findings without a demonstrated harmful outcome.

<a id="desktop-review"></a>

## Desktop safety and transport protocols

### Scope and evidence

Reviewed exactly **J10–J14, J19–J20 (7 groups)** from `docs/implicit-state-machines.md`, against production implementations, boundary callers, and tests. Read the review brief, repository instructions, and `GLOSSARY.md`. The checkout is `95570dd`; `git diff d5de813 -- apps/server/src/bot-desktop apps/server/src/workspaces` is empty, so these reviewed implementations match the requested baseline. No repository file was changed.

Classification: **1 P1 group, 2 P2 groups, 4 OK groups; 3 local findings**. The P1 finding exercises the real computer-use implementation through the repository's scripted guest seam, not a reimplementation. It does not claim real Chromium or a full HTTP concurrency reproduction. P2 findings distinguish conditional source proof from unexecuted production triggering conditions. An initially suspected owner-control race was rejected after assessing the intended whole-call admission boundary.

Executed 128 existing hermetic tests across 12 files: **128 pass, 0 fail, 395 assertions, 1.229 seconds**. Command:

```sh
cd apps/server && bun test src/bot-desktop/computer-use.test.ts src/bot-desktop/computer-use-login.test.ts src/bot-desktop/computer-use-page.test.ts src/bot-desktop/computer-use-intent.test.ts src/bot-desktop/computer-use-steps.test.ts src/bot-desktop/desktop-control.test.ts src/bot-desktop/desktop-intent.test.ts src/bot-desktop/intent-check.test.ts src/bot-desktop/desktop-screenshot.test.ts src/bot-desktop/desktop-viewer.test.ts src/bot-desktop/rfb-filter.test.ts src/workspaces/workspace-proxy.test.ts
```

No mutation experiments, real services, credentials, workspace startup, simulator, or emulator were used.

### Per-group analysis

<a id="group-j10"></a>

#### J10 — Taking control and observation invalidation — OK

`apps/server/src/bot-desktop/desktop-control.ts:10–23,51–72` represents authority with persisted holder, change count, and timestamp. A changed holder increments the count and publishes listeners; an identical assignment does nothing. Public control changes use synchronous `control.set` in `apps/server/src/bot-desktop/desktop-api.ts:87–90`, through synchronous access at `desktop-control.ts:120–138`. Consequently I reject a speculative lost-increment race between ordinary HTTP setters: these calls do not suspend between repository read and write. The listener-before-read protocol at `desktop-control.ts:94–117` prevents a missed hand-back. `keep-awake.ts:12–29` reconstructs owner holds at startup.

`apps/server/src/bot-desktop/computer-use-run.ts:20–38` waits for bot authority, compares generations, and clears observations. Acting calls after hand-back return a stale-state refusal. `computer-use-run.ts:92–110` repeats this after intent approval. Dispatch preparation subsequently awaits guest operations. A controlled seam demonstrates that an already admitted call can finish after takeover. However, the implementation plan explicitly checks authority at whole-call entry (`docs/plans/2026-10-21-desktop-jobs-m2.md:288–293`), and no cancellation/drain guarantee for admitted calls was established. I therefore reject this as a confirmed TOCTOU defect rather than treating a guest-send boundary as an undocumented requirement.

The authority row survives restart; observations and waiters do not. Existing tests `desktop-control.test.ts:29,50,65` assert monotonic changes, persisted authority, and waiter notification. `computer-use.test.ts:493` asserts waiting and stale refusal; `computer-use-intent.test.ts:178` asserts refusal when the generation changes *during judgment*. All passed. They cover entry/check-time authority, rather than stopping an already admitted call. The controlled seam reproduction sends a click with current holder `owner`, but this result alone does not refute the intended admission semantics.

<a id="group-j11"></a>

#### J11 — Intent check and suspended acting call — P2

`apps/server/src/bot-desktop/intent-check.ts:183–233` combines irreversible-action rules with judge scores. A judge failure falls back to rules, but cancellation propagates via `signal.throwIfAborted()`. `desktop-intent.ts:92–136` obtains the job request, judges, persists a pending hold, posts its transcript card, then waits. Approved returns permission; declined/expired returns refusal. `held-actions.ts:145–180` makes decisions an atomic pending-only update scoped to the bot, so competing owner decisions cannot both win. Its listener-before-read waiter at `held-actions.ts:207–241` handles an earlier decision without losing notification.

The persisted row and suspended call have different lifetimes. Startup expires surviving pending rows (`held-actions.ts:91–96`); cancellation *inside* `heldActionsAccess.until` expires the row (`held-actions.ts:271–281`). **Finding F26:** that cleanup does not cover failure/cancellation between hold insertion and entry into `until`, particularly transcript-card commit. The partial-failure branch leaves an actionable pending row without a caller. A real-store fault-injection reproduction confirms that conditional branch; production cancellation timing was not reproduced, so classification remains P2.

`desktop-intent.test.ts:96,108,141` checks no-card permission, pending card contents followed by approval, and decline text plus conflicting second decision. `intent-check.test.ts:140,155,240` checks rule floors, terminal fail-closed behavior, and judge fallback. All passed. No tests located cover interrupted card publication or hold cleanup outside the waiter. J10's authority checks were assessed at their intended whole-call admission boundary; post-admission completion was not classified as a separate defect.

<a id="group-j12"></a>

#### J12 — Computer-use observation validity — OK

`apps/server/src/bot-desktop/computer-use-state.ts:14–30` stores window snapshots, semantic element descriptions, query membership, and the latest browser binding/read. `forgetScreen` clears all four observation dimensions (`computer-use-state.ts:64–69`). Full captures replace element knowledge; diffs merge updates and removals, with the old snapshot's map removed (`computer-use-capture.ts:118–159`). `elementToken` requires a prior snapshot (`computer-use-capture.ts:72–83`). Queried captures explicitly block reuse as unrestricted diff bases (`computer-use-capture.ts:162–172`), preventing missing unrelated changes.

The production tool caches one instance per conversation (`apps/server/src/bot-desktop/computer-use.ts:96–106`), intentionally preserving observations across extension rebuilding; the desktop plugin also preserves the tool (`desktop-jobs.ts:72–91`). Different jobs execute serially through the exclusive holder claim (`apps/server/src/jobs/jobs.ts:422–473`), rather than arbitrarily racing maps in one JavaScript turn. State is transient after process restart, so a new element action must capture again. Browser refs are driver-validated; absence of a local membership check for every `actOnRef` is not by itself evidence that an invalid ref executes.

`computer-use.test.ts:20` asserts initial full capture followed by `since`-based diff; `:253` rejects acting before capture; `:592` asserts queried then plain captures omit `since`. `computer-use-steps.test.ts:135` asserts batch observation becomes the next snapshot. These passed. Driver session recovery invalidates maps; it does not guarantee successful replay of old element tokens, which can correctly be refused. Cross-job password knowledge is a separate invalidation defect in J14, not evidence of broken snapshot merging.

<a id="group-j13"></a>

#### J13 — Browser attachment, navigation, and driver recovery — OK

`apps/server/src/bot-desktop/computer-use-page.ts:100–179` binds a Chromium window, attaches only on `browser_consent_required`, invalidates observations on successful attachment, and retries binding once. Non-Chromium targets are refused. Browser reads update `lastRead` only after a successful semantic snapshot (`computer-use-page.ts:233–261`). Ref input uses that binding instead of rebinding whatever tab is active (`computer-use-page.ts:407–434`), which preserves target ownership across check and action.

`computer-use-page.ts:275–344` bounds navigation polling and returns a loading warning on timeout, rather than claiming definite load completion. This is readiness guidance, not a durable navigation task. `computer-use-driver.ts:173–188` retries an ended session once, starts the session, and clears observations. `computer-use-actions.ts:61–84` retries foreground delivery only after a driver refusal explicitly requiring that route. I reject a generic double-input hypothesis: success or an unverifiable result alone does not trigger the foreground retry. Unsafe replay after process crash is explicitly disabled at `computer-use.ts:78–79`.

`computer-use-page.test.ts:93,142` asserts attachment and reattachment after browser restart; `:173,200` asserts navigation-before-read and timeout warning; `:350` asserts driver stale-ref refusal. `computer-use.test.ts:96,329` asserts route escalation and one session restart/retry. All passed. No real-browser tests were run. Driver-specific stale-token and partial-native-operation semantics were not independently proved beyond these production protocol assumptions; no concrete additional defect was established.

<a id="group-j14"></a>

#### J14 — Password exposure and screenshot safety — P1

`apps/server/src/bot-desktop/computer-use-login.ts:47–143` requires the latest main-frame textbox ref, HTTPS, and a covering login host. It reads the password, records use, and persists exposure before typing (`computer-use-login.ts:178–184,234–250`). A persistence failure prevents typing. Raw values travel through environment/stdin rather than command arguments or guest files (`computer-use-driver.ts:205–220`). Output scrubbing handles literal and JSON-escaped values, longest first (`computer-use-state.ts:91–110`). Browser PID plus start time prevents a reused PID from withholding screenshots forever; uncertain identity fails closed (`computer-use-login.ts:188–215`).

`desktop-screenshot.ts:99–126` holds the workspace before liveness, exposure check, and capture, releasing it on every exit. This protects against idle stop, not concurrent new exposure. Crucially, **Finding F01:** computer-use instances restore durable exposure only once (`computer-use-login.ts:277–287`). An older cached job resumed after another job fills a password misses both redaction and screenshot refusal. This needs no concurrent desktop jobs or storage corruption.

`computer-use-login.test.ts:284,337,377` checks redaction, escaping, and same-job screenshot withholding. `:470` checks a *newly created* later job restores prior exposure. `:493` checks restart permits screenshots while retaining text scrubbing. `:530` checks persistence before typing. `desktop-screenshot.test.ts:121,145` checks exposure refusal and uncertainty. All passed, but none resumes an already initialized older job. The reproduction returns both literal test password text and an image from that job; process restart clears the stale instance and repairs restoration.

<a id="group-j19"></a>

#### J19 — Viewer ticket, bridge, and RFB input filter — OK

`apps/server/src/bot-desktop/desktop-viewer.ts:63–106` issues random one-minute tickets, checks expiry, and synchronously deletes on redemption. `desktop-api.ts:220–233` consumes the ticket before upgrade. Simultaneous ordinary upgrades cannot both redeem it; failed upgrade consuming the ticket is intentional fail-closed behavior. Page access only peeks. Tickets are transient across restart, requiring a fresh owner-authenticated link.

The socket queues bytes until stream attachment (`apps/server/src/bot-desktop/desktop-api.ts:154–204`); a stream acquired after socket close is immediately closed (`:165`). Bridge close is idempotent, closes the WebSocket, and ends the stream (`desktop-viewer.ts:158–169`). Output termination and input write failure share that path. Although `bridgeDesktop.receive` does not itself sequence asynchronous writes, the real `DesktopStream` does: `apps/server/src/workspaces/machine-workspaces.ts:518–526` chains writes. This rejects a speculative production write-reordering bug.

`rfb-filter.ts:5–28,70–106` consumes the fixed configured handshake, buffers partial messages, computes protocol lengths, and samples current control for input messages. Unknown types close the bridge; updates still pass. `desktop-viewer.test.ts:10,51` checks one-use/expiry and bidirectional filtering/closure. `rfb-filter.test.ts:36,47,54,64,93,110,118` checks control gating, clipboard lengths, QEMU keys, message lengths, partial frames, reassembly, and unknown types. All passed. This is not an untrusted-client resource-limit audit: pending queues and RFB frame sizes are not bounded here, but a credential-bearing authenticated viewer is required. No separate correctness finding was established from that alone.

<a id="group-j20"></a>

#### J20 — Workspace relay, proxy, and tunnel protocols — P2

`apps/server/src/workspaces/machine-workspaces.ts:758–843` accepts a daemon-argument line, pauses the socket during stream acquisition, forwards remaining bytes, and chains writes/end operations. **Finding F27:** socket-close cleanup is registered only after asynchronous daemon acquisition. A closed bridge can therefore acquire a late daemon stream without ending it. This is a conditional source-proven lifetime hole; backend timing and externally observable resource impact were not reproduced.

The proxy has a clearer acquisition boundary. `apps/server/src/workspaces/workspace-proxy.ts:137–215` bounds CONNECT/first-request collection by time and 64 KiB, pauses reading, removes event handlers, and rejects malformed or hostless requests. It inspects SNI/Host, resolves the inspected host, and selects a public address instead of trusting the CONNECT IP (`workspace-proxy.ts:51–73`). `:86–104,120–133` tracks sockets and destroys both forwarding peers on closure. Rejecting a first-server-speaking protocol is intentional, not a stalled handshake bug.

`apps/server/src/workspaces/railway/workspace-tunnel.ts:25–104` reassembles multiplexed frames and serializes guest writes. Python tracks both half-close directions (`workspace-tunnel.py:56–121`); stream EOF destroys TS sockets, and Railway reconnects ended tunnels unless stopped (`railway-workspaces.ts:506–525`). These are transient connections, not replayable request records. `workspace-proxy.test.ts:81,94,118,132,143,190,202,210` checks actual loopback forwarding, fragmentation, SNI, timeout, private-host refusal, malformed headers, and listener lifecycle. All passed. No dedicated relay/tunnel hermetic tests were located; Railway service tests were not run. No additional claim about end-to-end half-close correctness is made.

### Local findings

#### Rejected candidate — Dispatch preparation after owner takeover

**Verdict:** not counted as a defect. The experiment demonstrates completion of an already admitted tool call, not necessarily admission of a new call after takeover. **Affected ID:** J10, boundary to J11.

**Evidence:** `apps/server/src/bot-desktop/computer-use-run.ts:109,134` performs the final authority check, then dispatches. `apps/server/src/bot-desktop/computer-use-actions.ts:294–302` subsequently awaits `targetWindow`; `apps/server/src/bot-desktop/computer-use-driver.ts:245–275` performs asynchronous window listing and active-window lookup. Actual input is later sent by `computer-use-actions.ts:61–84,144–180`. Owner authority is independently mutable through `desktop-api.ts:87–90`, with no shared dispatch lock. Desktop-job exclusivity in `apps/server/src/jobs/jobs.ts:422–473` excludes another job, not an owner request.

**Minimal sequence:**

1. A job captures a window and has valid element knowledge while the bot holds control.
2. A click passes its intent check and the subsequent `controlTurn` check.
3. Dispatch suspends while obtaining its target window.
4. The owner takes control through the public control endpoint. This completes before the suspended lookup returns.
5. The lookup returns, and input dispatch proceeds without another authority check.

A stronger invariant requiring authority at every guest-send boundary would reject this sequence. However, the implementation plan explicitly puts the check at tool-call entry (`docs/plans/2026-10-21-desktop-jobs-m2.md:288–293`). The final post-intent check is a natural admission linearization point. Ownership does not change again within that synchronous check/admission operation; subsequent guest I/O belongs to the admitted call. The public response description (`apps/server/src/contract/api-responses.ts:303–313`) says work pauses while the owner holds control, but does not settle the fate of already admitted input. Therefore the source and reproduction do not establish a correctness violation under the intended admission model.

**Observed result:** `bun /tmp/crumble-state-review-d5de813/desktop-repro.ts` reported `holder at sent click owner`, `click count 1`, and a successful action result. The test shell records driver commands but does not operate a real desktop. Exact owner setter behavior is source-traced, rather than exercised through HTTP.

**Interpretation:** the result would matter if product requirements promised draining/cancelling admitted calls before takeover acknowledgement. That promise was not established. A later tool call detects the changed generation as designed. No P1/P2 is assigned for this schedule. The independent stale-password reproduction in the same script remains a confirmed finding.

**Optional contract test:** a deferred post-verdict lookup can make the admitted-call completion policy explicit. This is a semantics decision, not a failing-test prescription. The existing `computer-use-intent.test.ts:178` correctly changes generation during judgment and refuses before admission. No authority/admission rewrite is proposed without a stronger takeover guarantee.

<a id="finding-f01"></a>

#### F01 — P1 — Resuming an older job loses later password-exposure knowledge

**Evidence qualification:** The reproduction uses a shared in-memory fill-store seam, not the encrypted SQLite fill repository. Per-conversation cache reuse and per-bot durable storage scope were independently source-traced. Fixture plaintext requires an observable password-bearing surface; ordinary masked fields and password pixels were not established.

**Confidence:** high; reproduced against real production computer-use and the repository's existing scripted guest. **Affected ID:** J14.

**Evidence:** `apps/server/src/bot-desktop/computer-use-login.ts:277–287` permanently memoizes the first durable-fill read in `state.restored`. Successful fills update only their own state's `filled` and `browsers` collections (`computer-use-login.ts:178–184`), alongside durable storage. `computer-use.ts:96–106` caches separate computer instances per job conversation. `desktop-jobs.ts:72–91` intentionally preserves that tool across extension rebuilding. Jobs persist their conversations (`apps/server/src/jobs/jobs.ts:909–932`) and the public `send` path reuses the existing named job (`jobs.ts:1333–1379`); exclusivity serializes work but does not refresh cached state.

**Minimal sequence:**

1. Job A executes any computer-use call when the desktop has no exposure records. Its one-time restoration completes with empty maps.
2. A finishes. A different job B reads an HTTPS sign-in page and fills a password in Chromium. The exposure record is persisted before typing.
3. The bot sends more work to A, reusing A's conversation and cached computer instance. Chromium has not restarted.
4. A captures or reads a surface containing that password, or requests a vision capture.

A does not reload B's record. `passwordMayShow` returns false immediately for an empty `browsers` set (`computer-use-login.ts:200–204`). `scrubFilled` also returns unchanged output for an empty `filled` map (`:258–273`). Thus both text redaction and screenshot withholding fail. This violates the glossary promise that a login password never reaches the model or transcript. No simultaneous desktop execution, malicious owner, storage corruption, or missing persistence is required.

**Observed result:** `bun /tmp/crumble-state-review-d5de813/desktop-repro.ts` used an actual B `fill_login` call. It printed `persisted records 1`, then A's result contained `value="hunter2"` and an image. Summary: `raw password returned true image returned true`. The password is synthetic. The screenshot is fixture bytes; the experiment proves image admission, not rendered password pixels. Text disclosure is directly observed.

**Consequences and severity:** cross-job secret disclosure is meaningful security impact, scoped to the same bot's desktop and its model provider/transcript. The only extra precondition for text disclosure is a page/tree that exposes the filled value; existing tests already model that supported driver behavior. Screenshot admission violates the deliberately conservative browser-lifetime policy even before proving displayed pixels. Further calls retain the stale maps. Process restart or a newly created computer instance reloads records and repairs the omission, but cannot retract prior disclosure.

**Test gap and deterministic regression:** `computer-use-login.test.ts:470` creates the later reader only *after* persistence, so it passes. Create A first and initialize it; use B's real fill path with the same `DesktopFills`; resume A. Expect the label instead of raw text and no image, without restarting Chromium. Current results are the opposite.

**Ownership boundary:** exposure knowledge belongs to the bot desktop, not an individual job. Either refresh the durable append-only exposure set at each tool-call boundary or share an invalidated/updated exposure registry among all cached instances. Preserve record-before-typing and fail-closed read behavior.

**Remediation:** Computer-use calls now refresh and merge persisted exposures before dispatch. A failed refresh refuses the call, and writes still complete before typing. Historical text scrubbing and Chromium-instance screenshot rules remain unchanged. The preceding finding records the original audit, not the current implementation.

**Verification:** Before the fix, `bun test apps/server/src/bot-desktop/computer-use-login.test.ts` failed the two resumed-job regressions with synthetic plaintext and the later-read failure regression; 24 tests passed, including deferred and rejected writes. After the fix, `bun test apps/server/src/bot-desktop/computer-use-login.test.ts apps/server/src/bot-desktop/desktop-screenshot.test.ts` passed all 34 tests. `env CRUMBLE_VM_TESTS=0 CRUMBLE_RAILWAY_TESTS=0 bun run check` passed with 1,065 tests passed and 118 backend tests skipped. In `apps/docs`, `bun run check` passed. Fixture images establish admission or withholding, not real password pixels; the shared fixture does not exercise encrypted SQLite persistence or a live desktop. Concurrent fill and screenshot coordination remains outside this remediation.

<a id="finding-f26"></a>

#### F26 — P2 — Cancellation before card commit admission may orphan a pending approval

**Confidence:** High in the missing cleanup conditional; medium in the unexecuted full-runtime cancellation schedule. **Affected ID:** J11.

**References:** `apps/server/src/bot-desktop/desktop-intent.ts:83–89,116–131`, `apps/server/src/bot-desktop/held-actions.ts:91–96,116–133,145–180,271–281`, `apps/server/src/bot-desktop/held-action-notices.ts:11–40`. Installed Pi Durable references: `dist/harness/tool.js:258–265`, `dist/harness/scheduler.js:1989–2003,2138–2156`, `dist/session/session.js:157–164,521–570`.

**Actual transition and candidate failure sequence:** The gate persists a product-store hold, publishes a transcript card, then enters the decision waiter. The hold operation receives no tool cancellation context. Delay its return after insertion; abort the real tool context; release it so publication attempts to enter `api.commit`. The commit can reject before admission because the context or durable invocation is aborted. The gate exits before entering `held.until`, whose failure cleanup is the only pending-row expiration here. The row can remain pending without a suspended caller. An independent held-action notice can expose it even without a transcript card.

**Invariant and reachable-versus-unverified distinction:** Pending approval must represent a live suspended action. Production dependencies provide the pre-admission abort edge, but that exact runtime sequence was not executed. The temporary reproduction substitutes publication rejection while retaining the real gate and product-store service. It observes pending status followed by successful approval; it proves missing enclosing cleanup, not all real commit failures.

**Rejected stronger failure claim:** Once a transcript commit is admitted, its storage settlement does not use the caller abort signal. Cancellation after successful publication reaches the waiter's existing expiration cleanup. A backend commit error can fail the Harness; service reconstruction expires pending rows. Therefore do not claim that arbitrary post-admission cancellation or an ambiguous committed card necessarily leaves a durable orphan.

**Impact and recovery:** An orphan approval cannot dispatch the departed call: its gate already failed and has no waiter. Approval merely records a misleading successful decision. Retrying can create another hold. Restart expires still-pending rows; an already approved orphan remains approved. No approval bypass, irreversible action, or cross-account impact is proved.

**Tests and deterministic proposal:** `apps/server/src/bot-desktop/desktop-intent.test.ts:108–139` tests card/approval; `:141–174` tests refusal and repeated decisions, not pre-publication cancellation. At the real ToolExecutionApi seam, gate the hold return after insertion, abort before transcript commit admission, and assert expiration plus approval conflict. Separately cancel after storage admission to verify the existing waiter cleanup. The missing ownership boundary is enclosing pending-only cleanup around publication and waiting, not rollback of settled approval or a cross-database transaction.

**Executed conditional reproduction:** `bun /tmp/crumble-state-review-d5de813/desktop-orphan-repro.ts` reports publication rejection, then `pending`, then accepted `approved`. Real-runtime cancellation remains a proposed experiment, hence P2.

<a id="finding-f27"></a>

#### F27 — P2 — A daemon stream acquired after bridge closure is not closed

**Confidence:** high for conditional source behavior; medium for production timing and impact. Static trace only; no reproduction executed. **Affected ID:** J20.

**Evidence:** `apps/server/src/workspaces/machine-workspaces.ts:820–840` awaits `machine.stream` before installing socket `end`/`close` listeners. There is no post-acquisition `socket.destroyed`/`readableEnded` check. The earlier relay listener at `machine-workspaces.ts:763–768` only removes the socket from a tracking set and handles errors; it cannot end a daemon that has not been acquired. Compare the explicit late-attachment guard in `apps/server/src/bot-desktop/desktop-api.ts:165`.

**Minimal sequence:** a bridge connects and submits a valid argument line; daemon stream acquisition suspends; the bridge exits or disconnects, and the socket's close event fires; stream acquisition then succeeds. Newly registered listeners cannot receive that past close event. The relay enters `for await (daemon.output)` without calling `daemon.end()`. If that daemon waits for stdin EOF, it remains alive. This final process-lifetime condition is not measured here.

**Reachability:** the public workspace execution path uses a real bridge process (`machine-workspaces.ts:728–729`; `workspace-bridge.ts:7–20`). Microsandbox acquisition awaits remote exec and stdin acquisition (`apps/server/src/workspaces/microsandbox-workspaces.ts:344–365`), so suspension is real, not a synchronous scheduling invention. Dependency boundary trace: installed pi-env `dist/connection.js:201–254` races startup against a timeout, then kills the bridge; this can close the relay socket before a slow stream arrives. Ordinary per-command cancellation does not necessarily kill the connection, so I do not claim every job stop triggers this leak. No dependency defect is alleged.

**Invariant and consequences:** a client-owned stream must be ended if its owner departs during acquisition. Retries can acquire more streams while an old daemon is orphaned. A whole-machine stop ultimately removes transient processes; retry alone has no cleanup reference. Impact is bounded per affected workspace but potentially accumulates daemon/process resources. Since the real remote timing, daemon response to writing into a destroyed local socket, and eventual backend cleanup were not exercised, this remains P2 rather than a confirmed user outage.

**Test gap and deterministic proposal:** use `MachineWorkspaces` with an injected `WorkspaceMachine`, then obtain its real relay bridge path through the existing connection path. Delay `machine.stream` using a deferred; close the local bridge socket before releasing a `MachineStream` whose output waits until `end`. Assert `end` runs exactly once and output iteration terminates. Current source has no call that can meet that assertion after the missed close event. Also cover output-iterator failure to verify resource cleanup. `machine-workspaces.test.ts` has machine-lifecycle tests, but no such relay test was found.

**Ownership boundary:** register closure intent before awaiting acquisition, then immediately end a late stream. Keep ordered write/end forwarding for the live branch. This is the same concrete acquisition/owner-loss invariant already enforced by the viewer attachment path; a general protocol framework is unnecessary.

### Limits and rejected speculative issues

- No review of workspace provisioning/recovery or secret-value cache internals, except the stream-acquisition and job-reuse boundary traces necessary for these groups.
- Did not execute real browser, RFB server, Microsandbox, Railway, or Python guest tunnel tests. In particular, end-to-end tunnel half-close semantics and backend cleanup latency remain unmeasured.
- Did not infer that asynchronous RFB writes reorder: the production `DesktopStream` serializes them.
- Did not infer an HTTP setter lost-update race from Effect generator syntax: owner control setters use synchronous access.
- Did not claim approval races execute twice: pending-only database updates arbitrate decisions.
- Did not claim any unknown ref or session-recovery retry succeeds on a stale target; the driver can refuse it.
- Existing tests passed without modification. These results are not mutation proof or proof that the identified missing schedules are covered.

<a id="web-core-review"></a>

## Web delivery, sessions, and authentication

### Scope and evidence

Reviewed exactly **W01–W08 and W18–W19: 10 groups**. Findings: **0 P0, 2 P1, 0 P2, 0 P3**. Seven groups are OK within the inspected scope; W01, W02, and W05 participate in the two findings.

Read the review brief completely, the inventory, `GLOSSARY.md`, and the applicable project instructions. No repository files or tests were changed. Throwaway tests and this report are under `/tmp/crumble-state-review-d5de813`.

The checkout is `95570dd0519ca22b8a3361b26af8e23c59f687a0`, not the requested `d5de813`. I checked the comparison: **all inspected `apps/web` code and tests are unchanged between those commits**. Relevant server files cited here are also unchanged. The nearby bot runtime changed its opt-in partial-text option and associated types/tests; I inspected that diff rather than treating current runtime line numbers as target evidence. Tests ran in the available checkout, not a separate target worktree. The working tree already contained untracked `docs/implicit-state-machines.md`; it remains untouched.

References are repository-relative and include their full application path. Installed dependency references identify the actual dependency source used to verify behavior. No Effect code was written.

### Per-group analysis

<a id="group-w01"></a>

#### W01 — Optimistic bot chat delivery — P1

`apps/web/features/chat/delivery.ts:7–35` represents delivery using an account-local outgoing map and `sending | failed`. `deliver` installs a row before awaiting HTTP, keeps it on success, and marks only a matching existing row failed on error (`:68–117`). `confirm` removes rows by request identity (`:49–56`), called from transcript changes in `apps/web/features/chat/conversation.tsx:130–137`. A snapshot arriving before the HTTP result therefore does not resurrect a failed row. Retry preserves identity, attachments, and reply target through `conversation.tsx:329–337`. Server admission compares the original content, reply identity, and attachment digest before reusing an execution (`apps/server/src/bots/bots-submissions.ts:37–45,69–100`). HTTP acceptance is not completed bot work.

The defect is the first-attempt rejection transition: text returns to the composer, but reply identity does not; see finding F18. Ambiguous failures correctly retain the outgoing envelope. Transient outgoing rows disappear on reset/reload; this is not a durable offline queue. A restart after ambiguous admission can recover the server execution by identity only if the browser retained its outgoing row.

Tests: `apps/web/features/chat/conversation.dom.test.tsx:265` asserts restored text and no failed transcript row after `400`; `:288` asserts `502` retains a retryable row and an empty composer. Neither asserts restored reply identity. `apps/web/features/chat/delivery.test.tsx:11` asserts outgoing count changes from one to zero on reset. All executed successfully.

<a id="group-w02"></a>

#### W02 — Composer clearing, restoration, and attachment conversion — P1

`apps/web/features/chat/composer.tsx:647–684` owns draft text, uploads, errors, and sending state. Submission captures text/uploads, clears them, awaits the caller, and restores failed text before newly typed text. `canSendDraft` (`:490–503`) blocks disabled, pending, empty, and over-capacity submissions. Real DOM events rerender the disabled control; I did not assume two synchronous user events bypass React's update behavior. Concurrent conversions use functional state updates, while the recovery counter permits pending restored attachments and newly selected files to coexist without silent truncation (`:150–195`). Over-limit recovery is deliberately visible and unsendable until files are removed.

Finding F18 concerns the recovery boundary with the parent-owned reply identity, not broken text/upload restoration. Draft text persists under a chat key (`apps/web/features/chat/drafts.ts:3–16`; `composer.tsx:611–616`); uploads and in-flight conversion are transient. Navigation/reload is not crash-safe attachment storage. Session reset removes saved drafts (`drafts.ts:19–27`).

Tests are substantive: `apps/web/features/chat/composer.dom.test.tsx:98` gates a failed send and asserts merged text, all nine files, disabled Send, and no extra call; `:155` gates file conversion across recovery and asserts the new file survives; `:219` asserts both concurrent additions remain; `:250` asserts remount persistence and successful-send clearing. These passed. Their callback contract is Boolean and cannot assert recovery of parent-owned reply metadata.

<a id="group-w03"></a>

#### W03 — Chat subscription ownership and reconnect — OK

`apps/web/features/chat/chat-stream.ts:7–31` stores controller, user count, and post-view follow predicate by chat key. Mount acquires or shares a stream, and cleanup decrements users; zero users abort only when the target no longer requires background observation (`:59–91`). Bot targets follow `status === "running"` (`apps/web/features/bot-chat/chat.tsx:78–98`); group targets never follow after view (`apps/web/features/group-chats/groups.tsx:98`). Cache updates reevaluate release, including a background bot settling idle. Reset aborts and clears all registered streams. The `finally` identity guard cannot delete a replacement stream (`chat-stream.ts:54–56`).

`apps/web/lib/api.ts:214–239` reconnects transport failure/EOF with bounded delays; `401/404` end observation (`:192–210`). Each open invalidates the snapshot, and stream events replace cached snapshots (`chat-stream.ts:39–45`). Server setup attaches notifications and a runtime watch (`apps/server/src/bots/chat-api.ts:117–134`), while shared SSE cleanup runs registered disposers (`apps/server/src/shared/event-stream.ts:26–66`). No durable client event log exists; restart/reconnect obtains current state rather than replay.

`apps/web/features/chat/conversation.dom.test.tsx:349` explicitly asserts the controller remains unaborted after leaving running work, then becomes aborted after an idle cache update. `:380` asserts group exit aborts; `:310` asserts `404` navigates home. These passed. `apps/web/lib/api.test.ts:76` checks reconnect status after a dropped read, not a completed second connection; that limitation is not evidence of a production defect.

<a id="group-w04"></a>

#### W04 — Account activity follower — OK

`apps/web/app/activity-stream.ts:37–88` combines a monotonically increasing follower identity, controller, connection count, and external-store status. Only the current generation publishes connection status or clears controller ownership. Reset advances the generation before aborting the old controller (`:40–44`), preventing an old `finally` from marking a replacement disconnected. `apps/web/app/shell.tsx:89–108` starts observation in an effect and aborts it during cleanup. The public caller does not run arbitrary simultaneous followers; I rejected a hypothetical old-follower status race that ignores these guards.

On later connections, the follower invalidates both bot and group lists (`activity-stream.ts:65–72`). The server subscribes before sending a heartbeat and replaying current chat previews (`apps/server/src/bots/bot-activity-api.ts:32–49`), so preview recovery is not dependent on replaying reply events. Received reply activities invoke the notification subsystem; preview events update list data. All of this observation state is transient, recreated on page load. Missing historical activities during disconnection are not represented as a durable browser queue.

There is no direct generation/replacement test in the inspected web test inventory. The executed `apps/web/lib/api.test.ts:43` verifies handler exceptions reject instead of silently reconnecting, and `:76` verifies dropped reads enter reconnecting. These cover transport policy, not W04's generation guard. Static review found the ownership guard adequate; lack of a direct test is not graded as a failure.

<a id="group-w05"></a>

#### W05 — Sign-in, sign-up, and passkey ceremony — P1

Password submission, manual passkey sign-in, and passkey registration have separate mutations (`apps/web/app/connect.tsx:50–58,87–127`). Mode changes key-remount passkey controls (`:268–273`). Conditional mediation checks a local cancellation flag before calling the auth client; cleanup cancels the current browser ceremony (`:60–82`). Dismissed manual attempts advance the conditional-attempt counter. Successful entry resets browser account state and reloads (`:45–48`). Route guards check the actual session (`apps/web/app/router.tsx:61–80`). Server registration checks admission before registration and again after verification (`apps/server/src/app/auth.ts:155–199`); client mode is not an authorization boundary.

Finding F19 demonstrates that these controls do not own the auth client's preliminary options request. A delayed conditional request can start a new browser ceremony after manual sign-in is already active and abort it. This is a real asynchronous boundary, not synchronous-event speculation. Reload loses in-progress ceremonies; durable credentials/sessions remain server-owned.

No direct Connect/passkey DOM tests were found. `apps/server/src/app/auth.test.ts:13,20` assert relying-party origin normalization; `:132` asserts closed password signup requires an unused invite, and checks used/revoked invites fail. Those passed but do not exercise browser ceremony overlap. The new external reproduction uses the real Connect, real Better Auth client, and real SimpleWebAuthn abort service; seven assertions passed while demonstrating the failure.

<a id="group-w06"></a>

#### W06 — Session teardown and account switching — OK

`apps/web/lib/session.ts:1–15` synchronously invokes registered reset handlers, then directs signed-out users to Connect. `apps/web/lib/api.ts:53–56` cancels queries and clears the client, and HTTP `401` calls teardown before propagating the request error (`:79–95`). `apps/web/app/shell.tsx:64–81` detects established-user loss or replacement; replacement resets state and reloads because observation lifetimes are page-scoped. Explicit sign-out tears down on settlement, including a failed request (`apps/web/features/settings/settings.tsx:375–385`). This deliberately does not assert that a failed server sign-out deleted a server session.

Reset clears outgoing messages, aborts chat/account streams, removes persisted drafts, and clears unread counts. A late failed `deliver` maps the current list; it cannot restore its removed outgoing envelope (`apps/web/features/chat/delivery.ts:104–112`). Query implementations pass cancellation signals for snapshots and blobs. Hard navigation remains the account-switch isolation boundary; I did not infer a new account could mount inside an old page without that reload. Persistent account data belongs to server storage; transient client caches are reconstructed after navigation.

`apps/web/features/chat/delivery.test.tsx:11` verifies an existing failed outgoing row disappears after reset. `apps/web/features/chat/composer.dom.test.tsx:250` verifies draft persistence across ordinary remount, not reset isolation. Both passed. There is no inspected full-shell replacement/401 test. Throwing reset handlers under inaccessible browser storage remain an environmental robustness limitation; I did not demonstrate a normal supported-session path that creates a correctness/security finding from it.

<a id="group-w07"></a>

#### W07 — Provider sign-in dialog — OK

The dialog captures the active login identity, starts a new server login, and observes the resulting query (`apps/web/features/providers/provider-sign-in.tsx:27–68`). `apps/web/features/providers/api.ts:48–59` polls pending sessions each second. Terminal status invalidates providers/models; a server-lost session produces the `410` restart instruction. Hiding unmounts the dialog but does not cancel server work; explicit cancellation sends DELETE and closes after refresh (`provider-sign-in.tsx:44–50,94–140`). Prompt identity keys each form, so a new prompt receives fresh input state (`:169–170`). Answers carry the original prompt ID and replace cached server state on success (`:270–287`).

The server rejects answers to ended or replaced prompts (`apps/server/src/providers/provider-auth.ts:289–304`), releases prompt ownership synchronously on acceptance (`:408–444`), and commits credentials only while the login remains current. Guard, synchronous write, and success transition execute together in `apps/server/src/providers/provider-credentials.ts:157–173`. I rejected cancellation-between-guard-and-write as an impossible JavaScript interleaving. Restart intentionally loses pending sessions but not saved credentials.

No provider-dialog tests were found. The executed `apps/server/src/providers/provider-auth.test.ts:72,76,84,92` assert precise sanitized callback-port/provider failure codes, not polling, hide/resume, or prompt freshness. A delayed poll can briefly display stale prompt data, but server prompt validation rejects reuse and subsequent polling recovers; no permanent incorrect transition was established.

<a id="group-w08"></a>

#### W08 — MCP/GitHub authorization redirect return — OK

MCP start stores the target server in tab-scoped storage before leaving (`apps/web/features/integrations/integrations.tsx:191–210`). Return consumes that marker, validates code/state, includes issuer when supplied, exchanges, refreshes, and replaces the route (`:587–618`). GitHub installation uses a tab marker, while creation and owner authorization use separate code/state completion paths (`apps/web/features/github-apps/github-apps.tsx:51–52,79–89,700–737`). Installation does not trust GitHub's callback installation ID: the server discovers installations authenticated as the selected App (`apps/server/src/github-apps/github-apps.ts:381–412`).

`apps/web/components/redirect-return.tsx:29–40` uses a callback-URL query with retries, focus refetch, and reconnect refetch disabled, avoiding duplicate pending exchanges under StrictMode. It is not a durable exactly-once ledger: reload discards the cache, and one-use server state/code can require starting again after partial completion. MCP removes verifier/state after success (`apps/server/src/integrations/mcp-oauth.ts:323–368`); GitHub owner completion consumes pending state before exchange (`apps/server/src/github-apps/github-app-users.ts:184–234`). These are explicit failure/restart boundaries, not evidence of authentication bypass.

`apps/server/src/integrations/mcp-oauth.test.ts:175` asserts stale state rejection, correct PKCE verifier/challenge binding, successful token presence, duplicate-completion rejection, and sign-out removal; `:210` asserts incorrect issuer fails. Both passed. No direct RedirectReturn/GitHub callback UI tests were found. I did not claim query caching prevents every future error remount or reload from retrying a one-use exchange.

<a id="group-w18"></a>

#### W18 — Notifications, unread state, and audio unlock — OK

`apps/web/lib/notifications.ts:139–174` derives a chat path, suppresses bot-origin activities and visible-current-chat notifications, increments per-path unread counts, then optionally displays a notification. Counts clear when the route becomes visible or the session resets (`:66–88`). Persistent event-ID deduplication bounds notification history to 512 entries (`:28–35`); browser permission and preferences gate actual display (`:45–51`). Clicking focuses the window, navigates through caller-owned links, and closes the notification. Sound selection and browser-sound suppression are coordinated in `showNotice` (`:111–132`); user enabling sound calls audio unlock (`apps/web/features/settings/settings.tsx:96–159`).

Unread counts are transient; preferences and display deduplication persist on this browser. The implementation does not confuse provider acceptance with owner acknowledgment. I rejected treating reconnect alone as duplicate unread delivery: `apps/server/src/bots/bot-activity-api.ts:32–49` replays previews, not historical reply events. Unread counting precedes notification deduplication, but no repeat-producing public path was established here. Browser notification/storage exceptions are caught after unread state updates rather than terminating the activity follower.

`apps/web/lib/notifications.dom.test.ts:57` asserts an illegal Notification constructor does not throw from `notifyReply`; `:71` asserts full storage does not throw. Both passed. These tests do not verify deduplication, click navigation, unread clearing, or audio activation. Browser autoplay behavior and real notification delivery were not exercised.

<a id="group-w19"></a>

#### W19 — Asynchronous rendering resource lifetime — OK

`apps/web/components/markdown.tsx:21–68` owns diagram load/mount state through an effect-local stopped flag and destroy callback. Cleanup prevents a not-yet-started import continuation from mounting, destroys completed mounts, and destroys a mount that resolves after cleanup. Late errors do not update unmounted state. Diagram inputs disable links and images, and dependency size limits remain active. `apps/web/features/chat/transcript.tsx:235–273` fetches image blobs with a query signal, creates a URL for the current blob, revokes that URL on replacement/unmount, and refuses to render a URL whose blob no longer matches query data. The cache stores blobs rather than object URLs.

These are transient DOM resources, with no startup recovery requirement beyond remounting from transcript/blob data. I inspected Pele's lazy implementation: it awaits a diagram module before mounting. Therefore the stopped flag after `mountAsync` is not itself a cancellation mechanism for source replacement. However, inspected production Reply callers render completed transcript/job entries, and I did not establish a public same-mounted-diagram source-replacement path producing wrong output. I have not promoted that dependency-level possibility to a finding.

`apps/web/features/chat/transcript.test.tsx:27` asserts exact first/second blob URL creation, first-URL revocation during replacement, and both revocations on unmount. `apps/web/lib/api.test.ts:4` asserts blob retrieval does not create a URL. Both passed. No diagram deferred-import/mount test was found.

### Findings

<a id="finding-f18"></a>

#### F18 — P1 — Rejected reply restoration silently changes the next message's target

**Confidence:** High; source-proven and reproduced against the real `useConversation` implementation. **Affected IDs:** W01, W02.

**Evidence:**

- `apps/web/features/chat/conversation.tsx:78–106`: `sendMessage` captures the default `replyTo?.entryId`, immediately clears reply state at line 84, and never restores it when returning `false` for a first-attempt rejection.
- `apps/web/features/chat/composer.tsx:665–683`: `false` restores draft text and uploads only. The parent reply target is outside this Boolean recovery contract.
- `apps/web/features/group-chats/groups.tsx:306–307`: the reply banner is driven by that parent reply state.
- `apps/server/src/group-chats/group-chat-post.ts:78–89,107–115`: the server resolves reply metadata and uses it when selecting addressed members.
- `apps/server/src/group-chats/group-chat-members.ts:23–32`: replying to a bot adds that bot to addressed members; without mentions/reply targeting, group posting wakes all members.

**Minimal sequence and preconditions:**

1. Open a bot/group chat and select **Reply** on an existing message.
2. Submit a first-attempt message that receives an unambiguous rejection below `500`, such as a correctable validation `400`.
3. Observe restored text/uploads, but no restored reply banner.
4. Correct the message and submit without manually selecting **Reply** again.

**Violated invariant:** Recovery of a refused draft must preserve the message's semantic envelope, not just its text/files. **Observed outcome:** the first request contains `replyTo`; the corrected second request does not. For a reply to a group bot with no explicit mentions, server code proves this can change dispatch from the replied-to member to all members. That group-dispatch consequence was statically traced, not executed against a bot runtime. The public UI reaches this path through `Composer.onSend`; no corruption, concurrent event trick, or restart is required.

**Retry/restart and severity:** Ambiguous-failure **Retry** correctly preserves the outgoing envelope and is not affected. The bug concerns the automatic composer restoration path. A reload also loses transient reply selection; it does not repair this send. The blast radius is one refused reply and potentially unintended group members doing work. It does not bypass server authorization. Rejection is less frequent than successful sends, but correcting a refused draft is ordinary behavior. This is a meaningful user-visible correctness defect, hence P1.

**Test gap:** `apps/web/features/chat/conversation.dom.test.tsx:216` checks the optimistic reply quote, while `:265` checks rejection restoration separately. Neither combines those transitions or checks the second POST body. Composer recovery tests cannot see parent-owned reply identity.

**Executed reproduction:** `/tmp/crumble-state-review-d5de813/reply-repro.test.tsx` mounts the real hook under the real router/query providers, stubs only HTTP responses, selects a reply, returns `400`, then submits corrected content. Command:

```sh
bun test --tsconfig-override /Users/leonhardbreuer/Developer/crumble-project/bot/apps/web/tsconfig.json /tmp/crumble-state-review-d5de813/reply-repro.test.tsx
```

Result: **1 pass, 0 fail, 5 assertions**. Recorded output includes `restoresComposer:true`, `replyAfterRefusal:"no reply"`, first body with `replyTo:"g:1"`, second body without `replyTo`. Assertions intentionally characterize the defect, not desired behavior. The first harness attempt failed because absolute dependency imports created separate context instances; switching to normal package resolution fixed the harness. No production code changed.

**Deterministic regression proposal:** Extend the actual group DOM test seam: click Reply on a bot message, gate the POST, return `400`, assert the banner and target survive restoration, edit, and assert the next POST retains the same target. Also select a new reply while the first request is pending; recovery must not overwrite a newer owner selection. An owned failed-send envelope/recovery result is justified here because text, files, and reply identity share the demonstrated recovery invariant. A generic FSM framework is unnecessary.

<a id="finding-f19"></a>

#### F19 — P1 — Delayed conditional passkey options abort manual sign-in

**Confidence:** High; reproduced using the real Connect component, Better Auth passkey client, and SimpleWebAuthn abort service. **Affected ID:** W05.

**Evidence:**

- `apps/web/app/connect.tsx:54–57`: manual sign-in invokes `authClient.signIn.passkey()` independently of conditional sign-in.
- `apps/web/app/connect.tsx:60–82`: the conditional path starts on mount; its cancellation check occurs before calling the auth client. Cleanup cancels only an already-created ceremony. A manual click does not invalidate the conditional path's options acquisition.
- `apps/web/node_modules/@better-auth/passkey/dist/client.mjs:7–25`: the real client first awaits `/passkey/generate-authenticate-options`, then calls `startAuthentication`. Its preliminary HTTP request is not tied to the component's cancellation flag.
- `apps/web/node_modules/@simplewebauthn/browser/esm/methods/startAuthentication.js:45–68`: after conditional checks, each call obtains a new singleton abort signal and invokes `navigator.credentials.get`.
- `apps/web/node_modules/@simplewebauthn/browser/esm/helpers/webAuthnAbortService.js:10–18`: creating that signal aborts the previously active browser operation.

**Minimal sequence and preconditions:**

1. Use a secure hostname where WebAuthn and conditional mediation are supported. Connect remains in sign-in mode, so its `email webauthn` input exists.
2. Hold the initial conditional authentication-options response in flight.
3. Click **Sign in with a passkey**. Let the second options response complete and the manual `navigator.credentials.get` become active.
4. Complete the original conditional options response before the owner finishes the manual ceremony.

**Violated invariant:** An older background attempt must not cancel a newer explicit owner attempt. **Observed outcome:** the late conditional call creates a new abort signal and aborts the active manual call. Connect treats that manual failure as a dismissal, increments its attempt counter, and starts conditional mediation again. The reproduction recorded three ceremonies: manual aborted, old conditional aborted, replacement conditional still active. This relies on genuine awaits across two HTTP requests and credential acquisition, not an invented synchronous race.

**Public reachability and severity:** Both calls originate from the standard Connect UI; no private API use is required. Delayed/reordered options responses are the only timing precondition beyond supported passkeys. The owner sees manual sign-in unexpectedly dismissed and remains signed out. Password sign-in or another manual attempt remains available, so this is not a permanent account lockout or a security bypass. Slow or reordered first-load requests make it intermittent. The blast radius is one browser sign-in attempt. P1 reflects an actual authentication interaction failure, not merely missing cancellation architecture.

**Retry/restart:** Reload starts a fresh conditional flow and does not eliminate the overlap. Retrying after options have settled can succeed. No durable account/session writes occur in the demonstrated aborted ceremony. Separate server signup/invite enforcement remains intact.

**Existing-test gap:** No Connect browser test was found. Server origin/signup tests do not exercise real client options acquisition or the dependency's singleton cancellation service.

**Executed reproduction:** `/tmp/crumble-state-review-d5de813/passkey-repro.test.tsx` uses fake HTTP option responses and a deterministic `navigator.credentials.get` boundary that rejects when its real abort signal fires. It does not reimplement any auth-client or cancellation logic. Command:

```sh
bun test --tsconfig-override /Users/leonhardbreuer/Developer/crumble-project/bot/apps/web/tsconfig.json /tmp/crumble-state-review-d5de813/passkey-repro.test.tsx
```

Result: **1 pass, 0 fail, 7 assertions**. Output: `{"optionsRequests":3,"ceremonies":[{"mediation":"manual","aborted":true},{"mediation":"conditional","aborted":true},{"mediation":"conditional","aborted":false}]}`. This proves the signals and component transitions in a DOM harness, not behavior of a physical authenticator or browser popup.

**Deterministic regression proposal:** Keep this real-client deferred-fetch seam. Hold conditional options, begin manual acquisition, resolve conditional options, and require that the manual signal remains live and no stale conditional acquisition starts. Cover mode switch/unmount during options fetch too. Ownership must include options acquisition as well as the browser ceremony; calling `cancelCeremony()` alone cannot cancel an operation that has not acquired a signal yet. Coordinate attempts at that actual boundary rather than adding an unrelated UI status enum.

### Executed checks and limits

1. `bun test apps/web/features/chat/delivery.test.tsx apps/web/features/chat/composer.test.tsx apps/web/features/chat/composer.dom.test.tsx apps/web/features/chat/conversation.dom.test.tsx apps/web/lib/api.test.ts apps/web/lib/notifications.dom.test.ts` — **22 pass, 0 fail, 46 assertions, 1.314 seconds**. Notification exception warnings are expected by those tests.
2. `bun test apps/web/features/chat/transcript.test.tsx apps/server/src/providers/provider-auth.test.ts apps/server/src/integrations/mcp-oauth.test.ts apps/server/src/app/auth.test.ts apps/server/src/group-chats/group-chats-api.test.ts` — **26 pass, 0 fail, 92 assertions, 1.95 seconds**. OAuth endpoints are hermetic local fixtures, not real providers.
3. Two external reproduction tests — **2 pass, 0 fail, 12 assertions**; both assert observed defective behavior.

No full lint/typecheck, complete test suite, browser automation, real credentials/services, workspace startup, simulator, or emulator ran. No mutation testing occurred. GitHub callback UI, activity generation replacement, provider prompt polling, and diagram lazy-mount cleanup lack direct executed tests in this review; their assessments rely on source tracing and the related seams stated per group. W09–W17, W20, and the site were not audited, except minimal caller boundaries needed for the assigned groups.

<a id="web-features-review"></a>

## Web feature workflows and landing-page playback

### Scope and evidence

Reviewed exactly **W09–W17, W20, S01 (11 groups)** against the inventory at `d5de813`. The checkout is `95570dd`; `git diff d5de813 HEAD -- apps/web apps/site --stat` was empty, so inspected web/site sources match the requested commit. Read the review brief, repository instructions, canonical `GLOSSARY.md`, and inventory. No repository files were changed. Server traces below are boundary checks supporting the assigned frontend groups, not separate audits of server IDs.

**Verdict:** two confirmed P1 frontend correctness bugs, two P2 candidates, seven groups OK within inspected scope. No P0 findings. “OK” does not mean exhaustive browser or service validation.

#### Executed checks

- Existing hermetic tests: `bun test apps/web/features/skills/bulk-skill-actions.test.ts apps/web/features/skills/bulk-skills.dom.test.tsx apps/web/features/bot-secrets/bot-secrets.dom.test.tsx apps/web/features/message-gateways/message-gateways.dom.test.tsx apps/web/features/settings/admin-settings.dom.test.tsx apps/web/features/automations/automations.test.tsx apps/web/features/jobs/jobs.test.ts apps/web/features/jobs/job-card.test.tsx`: **26 pass, 0 fail**, 81 assertions, 2.39 seconds. Log: `existing-tests-web-features.log`.
- Boundary/adjacent tests: `bun test apps/server/src/skills/skill-installer.test.ts apps/web/features/chat/conversation.dom.test.tsx apps/web/features/automations/timing.test.ts`: **15 pass, 0 fail**, 43 assertions, 1.14 seconds. Log: `boundary-tests-web-features.log`. Nonassigned chat cases in that file were executed incidentally, not audited here.
- Throwaway tests importing **unmodified real exported frontend implementations**, with happy-dom and controlled fetch gates: `bun test --tsconfig-override /tmp/crumble-state-review-d5de813/repro-tsconfig.json /tmp/crumble-state-review-d5de813/frontend-repros.test.tsx`: **3 pass, 0 fail**, six assertions, 264 ms. They assert the observed buggy behavior; they are reproduction evidence, not fixed regression tests. Log: `frontend-repros.log`. The fake HTTP server is not proof of actual server execution; source tracing establishes server consequences separately. An initial command invocation failed alias resolution; the command above corrected it.
- No real services, credentials, workspace startup, simulator, mutations, or production server were used. No Effect code was written. No full build/typecheck or live-browser suite was run.

### Per-group analysis

<a id="group-w09"></a>

#### W09 — Desktop control, viewer connection, and wake — P2

Control uses a persisted holder plus monotonic changes; the UI combines snapshots, a holder ref, SSE, and a PUT mutation (`apps/web/features/bot-desktop/desktop.tsx:22–67`). Older responses cannot replace a newer change. Viewer links are one-use; reconnect requests another. Preview uses passive viewing until explicitly asked to wake (`:112–124,246–275`). State survives restart on the server, which reconstructs owner holds; local viewer links do not.

The delayed-claim/departure behavior is reproduced, but F08 is P2 after independent verification: `apps/docs/content/concepts/workspaces.mdx:124–131` promises owner control survives closing, whereas normal frontend cleanup sends automatic hand-back. A late acquisition is not independently proved an unwanted stranded state. Resolve that product-policy conflict before deciding which transition is illegal. The actual code permits owner retention or hand-back depending on response/render timing.

No existing desktop lifecycle test covers both schedules. The temporary real-component test gates the claim response and observes retained owner control after unmount; server effects are source-traced, not live-desktop tested. F08 specifies a policy-dependent regression and multiple-client caveat. No unauthorized action or expiring lease is claimed.

<a id="group-w10"></a>

#### W10 — Held-action freshness and decision UI — OK

`apps/web/features/bot-desktop/held-action.tsx:26–58` resolves transcript identity against a live list; cached terminal actions are conclusive, while pending/missing actions await a post-mount successful fetch. `apps/web/components/request-card.tsx:32–45` explicitly distinguishes trustworthy data from Loading/Unavailable. Decline first opens a reason step, then submits; approve disappears while declining, and pending mutation disables both actions (`held-action.tsx:103–160`). Settled/error outcomes invalidate the action list (`held-action.tsx:62–79`). Pending rows poll every five seconds (`apps/web/features/bot-desktop/api.ts:26–36`).

Rejected hypothesis: a stale approve click can reapprove an expired/declined action. Server update requires matching bot, ID, and `pending` status; losers receive conflict, not a second dispatch (`apps/server/src/bot-desktop/held-actions.ts:144–182`). Surviving pending rows expire at process startup (`held-actions.ts:91–96`), and UI polling observes that; React decline drafts are intentionally transient. Existing boundary test `apps/server/src/bot-desktop/desktop-intent.test.ts:141`, “a declined action is refused with the owner's reason,” asserts the refusal text and that subsequent approval rejects with Conflict. Its approval counterpart at line 108 checks the emitted card, pending metadata and final approved status. These were statically read, not executed in this partition. No direct freshness/reason-step DOM test was found; absent coverage alone is not a defect.

<a id="group-w11"></a>

#### W11 — Job observation, question answers, and export — P1

Jobs poll at three seconds while working/questioning and fifteen seconds while idle, always refreshing on mount (`apps/web/features/jobs/api.ts:17–29`). Job transcript history has bot/kind/name/status in its key and consumes query cancellation signals (`apps/web/features/jobs/jobs.tsx:232–255`); changing job identity cannot publish old history into the new key. Transcript-derived job counts invalidate lists on changes (`apps/web/features/jobs/chat-jobs.ts:20–29`). Export walks pages serially and revokes the object URL after triggering a download (`jobs.tsx:351–394`); it is transient, not resumable or a frozen snapshot of concurrently growing history.

**Finding F16:** the unkeyed question-answer component in `jobs.tsx:494–500` preserves old text/options when polling jumps directly from one question to its successor. The new mutation uses the new question ID, so the server's old-ID guard does not help. Draft state is lost on remount/reload, but accepted answers are durable server work.

Existing `apps/web/features/chat/conversation.dom.test.tsx:409`, “job messages refetch the job list, and a card reads its own kind's job,” asserts kind-correct statuses and exactly one extra coding-job fetch. Executed successfully. `apps/web/features/jobs/jobs.test.ts:6–20` tests cost formatting only, and `job-card.test.tsx:24–38` tests failure-card rendering/selection, not answer transitions. F16 was reproduced with actual `JobQuestionAnswer`; no export/download browser experiment was run.

<a id="group-w12"></a>

#### W12 — Bot requests and secret request cards — OK

Bot request cards reconcile transcript proposals with the live request list; approve can submit either the proposal or edited bot fields (`apps/web/features/bot-requests/bot-request-card.tsx:39–68`). Success closes the editor, seeds the bot list if present, and refreshes authoritative lists; error also refreshes (`bot-request-card.tsx:99–142`). UI disablement reduces duplicate clicks, but server pending-only claim is the correctness boundary, not the spinner. Secret cards match both name and optional request timestamp, preventing an old transcript card from rendering a later same-name request as its own (`apps/web/features/bot-secrets/secret-request.tsx:33–55`). `useFreshRequest` avoids declaring a newly arrived request declined solely from a fresh-looking earlier cache.

Decline POST is deliberately separate from saved-item DELETE (`apps/web/features/bot-secrets/bot-secrets.tsx:530–547`); saved credentials/logins may coexist with a request for additional hosts. Nested sheet flags are transient; actual requests and saved items survive reload independently. No frontend durable replay is attempted after ambiguous save failure; refresh resolves current server truth.

Executed `apps/web/features/bot-secrets/bot-secrets.dom.test.tsx:267,299` assert decline endpoints preserve the saved-item distinction; tests at 282/320 seed a cache missing a newer request and require answer controls, not Saved. Tests at 379/403 assert exact submitted secret/reference payloads. No direct bot-proposal decision DOM test was found. Simultaneous-client visual staleness is possible, but duplicate bot creation was rejected by the traced pending-only server protocol, not treated as a bug.

<a id="group-w13"></a>

#### W13 — Skill discovery and update review — P2

Discovery separates entered location, submitted query identity, and optional selection override (`apps/web/features/skills/skill-install.tsx:202–240`). Editing location clears submitted identity and selection; older discovery completion remains under its old query key rather than becoming the current listing. Find/refetch disables installation while fetching; initial installation includes the discovered immutable commit (`skill-install.tsx:185–198,246–258`). Thus “upstream changed after Find silently changes the initial install” is rejected: `apps/server/src/skills/skill-installer.ts:296–324` fetches by requested commit.

Update review differs: current/candidate queries are keyed only by skill ID and apply POST carries no reviewed commit (`skill-install.tsx:488–521`). **F24** is an unverified review/adoption mismatch if another update check replaces the persisted candidate while a preview is open. Server `pending` and `apply` independently read the latest candidate (`apps/server/src/skills/skill-installer.ts:442–485`). There is no crash recovery for an open review; reload fetches again, while candidate and installed versions are durable. A failed apply keeps the dialog for retry; a successful apply invalidates skill/catalog caches and closes.

Executed `apps/server/src/skills/skill-installer.test.ts:190`, “installs read-only shared skills with their documents, all or none,” checks installation atomicity; line 238, “finds upstream changes to imported files, applies them as a revertible change,” asserts pending/applied instructions and update clearing. It does not put another check between preview and apply. No frontend discovery/update-review transition test was found. F24 remains P2 rather than claiming an executed stale-adoption failure.

<a id="group-w14"></a>

#### W14 — Partial-success bulk skill operations — OK

Selection, action dialog, targets, report and mutation state live in `apps/web/features/skills/bulk-skills.tsx:261–319`. Starting closes configuration; pending state disables selection/action controls. Completion retains failed skill IDs and a full report before invalidating catalog/bot data. Actual workers claim their next bot index synchronously before awaiting; there is no JS race allowing two workers to claim the same index (`apps/web/features/skills/bulk-skill-actions.ts:90–113`). At most four bots run concurrently, while the outer skill loop awaits every bot result before starting another skill (`bulk-skill-actions.ts:138–176`). Per-item errors accumulate rather than short-circuiting.

Rejected hypothesis: retrying an assignment after partial success blindly overwrites entire bot skill arrays. It posts the dedicated assignment operation; repeated desired state can return skipped. Deletion retries and update checks still consult current server state. Browser close does not transactionally cancel the entire batch; committed items remain durable, while selection/report are lost. That is a residual partial-batch boundary, not an all-or-nothing promise.

Executed tests at `apps/web/features/skills/bulk-skill-actions.test.ts:34,129` use deferred fetches to assert peak concurrency four, every outcome observed, stable ordered results, and no next skill until all current bots settle. DOM tests at `apps/web/features/skills/bulk-skills.dom.test.tsx:327,392,423` assert only failures remain selected, endpoint sequences, retries excluding unselected skills, and per-bot failure text. Line 517 gates bot refetch and requires eventual usage-count refresh. These assertions directly exercise the important boundaries.

<a id="group-w15"></a>

#### W15 — One-time invite/address reveal — OK

Event-source creation is a mutation: naming transitions to displaying returned address on success (`apps/web/features/event-sources/event-relay.tsx:204–246`); repeat submission is disabled while pending. Its address is intentionally transient UI data. Dismissing the sheet after creation discards the reveal, not the durable source; a late response after dismissal also cannot reopen the sheet. That residual one-time reveal window is inherent in this inspected UI, not proof of a silent background retry.

Invite creation is deliberately outside the invalidated admin query prefix: `apps/web/features/settings/admin-settings.tsx:136–145` uses `['new-invite']`, infinite stale time, zero GC retention. Thus closing then invalidating admin listings does not mint an invisible additional invite. The query does not consume an abort signal; close during a pending mint can still leave a valid invite whose URL is not shown, and transport-level ambiguous failure cannot guarantee exactly-once minting. This is not described as durable reveal recovery. Manual reopen mints a new invite; admin listings allow revoking prior invites.

Executed `apps/web/features/settings/admin-settings.dom.test.tsx:8`, “closing the invite sheet leaves the shown invite the only one minted,” counts POSTs and asserts exactly one before/after close and cache settlement. It validates the invalidation boundary but does not test pending-close or network failure. No direct source-address reveal test was found. No security bypass or mistaken durable replay was established.

<a id="group-w16"></a>

#### W16 — Automation editor and admission feedback — OK

Draft trigger and kind flags are projected into mutually exclusive request payloads, rather than sending all hidden form values. `apps/web/features/automations/editor.tsx:174–240` nulls cron/runAt for event triggers, nulls event source for time triggers, and `kindFields` at 139–170 clears command for prompt or prompt for script. Switching bots can demote script to prompt when coding is unavailable (`editor.tsx:399–416`). UI errors retain the draft; successful save waits for invalidation then closes (`editor.tsx:244–259`). No durable local draft or retry identity exists; reload reconstructs from server state.

Run-now checks `admitted` before refreshing histories or navigating (`apps/web/features/automations/automations.tsx:296–317`). Rejected hypothesis: any successful HTTP response is presented as completed bot work. False admission explicitly throws, and accepted work only opens the bot chat; it does not claim execution success. Pause/resume/delete defer lifecycle truth to refreshed state; server cancellation/admission internals remain outside this group.

Executed `apps/web/features/automations/automations.test.tsx:42`, “running an automation refreshes its histories and opens its bot,” observes seeded history queries, asserts navigation and refresh of executions/this schedule's runs but not another schedule's runs. `apps/web/features/automations/timing.test.ts:24` asserts event automation naming and nonfinished status. Missing cases include refused admission and editor cross-mode payload tests; static tracing found no concrete illegal payload transition, and these gaps alone are not findings.

<a id="group-w17"></a>

#### W17 — Gateway configuration adoption — P1

The editor owns local draft, attempted-validation flag, mutation state, and dirty comparison against authoritative `gateway.config` (`apps/web/features/message-gateways/message-gateways.tsx:642–686`). Status polling/cache refresh does not reset local draft: useful separation of live connection state and unsaved configuration. Submit validates against bots/schema before issuing PUT; failure leaves the draft and displays error. Reset explicitly returns to current authoritative config and clears mutation feedback. Success adopts returned config and updates the query cache before refresh.

**Finding F20:** success unconditionally replaces draft even if the user edited fields during the request. Inputs remain enabled: e.g. owner ID `message-gateways.tsx:529–537`; only Save/Reset are disabled, and `aria-busy` on the form is not a disabling mechanism (`message-gateways.tsx:630–635,705–708`). This is a real asynchronous response interleaving, not simultaneous synchronous setters. The later unsaved edit is lost; reload recovers only the first submitted value, since the second was never persisted.

Executed `apps/web/features/message-gateways/message-gateways.dom.test.tsx:9`, “owner validation, refresh, and failed disable preserve edits after its default bot is deleted,” checks invalid input suppression, status-refresh retention, exact PUT body, and retained draft on 500. It does not exercise a successful save with intervening edits. The controlled real-component reproduction does, observing second → first overwrite. The test at line 202 checks UUID fallback rendering, not adoption.

<a id="group-w20"></a>

#### W20 — Chat detail/job/mobile panel coordination — OK

Details preference, selected job, and mobile sheet are separate state in `apps/web/features/bot-chat/chat.tsx:52–75`. On wide screens, showing details closes a selected job first; rendering at `chat.tsx:346–356` selects job **or** desktop details, never both. On narrow screens the same header opens the sheet; the sidebar independently owns desktop open and mobile open, with toggling selected by current media state (`apps/web/components/ui/sidebar.tsx:56–110`). Job selection is keyed by kind/name, while `Chat` itself is keyed by bot ID at the route (`apps/web/app/router.tsx:100–103`), rejecting stale job selection leaking into a different bot.

Details preference alone persists in localStorage; sheet/job selections are transient. Neither an open job nor mobile details represents server authority or needs crash recovery. Browser resize can leave logically open mobile state for later reuse, but layout/CSS and library-owned dialog behavior prevent this alone from proving an illegal domain transition. `apps/web/features/bot-chat/details.tsx:125–167` separates hidden-on-small desktop panel from controlled mobile sheet.

No dedicated desktop/mobile coordination DOM test was found. The executed conversation test at `apps/web/features/chat/conversation.dom.test.tsx:409` checks job kind isolation and invalidation, not panel opening, resizing, focus or mobile layering. Static review covers ownership and keys; real responsive-layout/focus behavior remains untested. No finding is assigned solely for independent booleans or missing resize tests.

<a id="group-s01"></a>

#### S01 — Interactive demonstration playback — OK

Playback state is in-view latch, run/scenario, line index, busy and picked option (`apps/site/src/components/Transcript.tsx:1102–1170`). `waiting` freezes progress after choice and before selection; `done` stops timers, avoiding out-of-bounds `lines[at]` (`Transcript.tsx:1117–1127`). Scenario change/replay synchronously resets at/busy/picked and increments run. Child row keys include run/scenario (and picked for outcome rows), so desktop/terminal timelines remount instead of inheriting elapsed steps (`Transcript.tsx:1380–1400`). Rejecting stale scenario-timer callbacks is handled by effect cleanup on each render, not a fictitious concurrent setter lock (`Transcript.tsx:1038–1079`).

Reduced motion jumps to choice/end and child timeline completion (`Transcript.tsx:651–670,1056–1060`); approval's brief visual press is simulated presentation, not a payment. Nested timelines own and clear every timeout, and the intersection observer disconnects after first entry and on unmount (`Transcript.tsx:1012–1035`). All state is transient; page reload restarts the demonstration. No actual credentials, jobs, irreversible operation, cancellation API or durable replay are involved.

No site test files were found, and no site/browser timers experiment was executed. Static tracing covered normal choice, replay, scenario replacement, reduced motion and unmount cleanup. Theme-driven wrapper remount and live resize/scroll positioning were not experimentally exercised; no correctness claim about those browser-specific paths is made. No concrete reachable failure established in the reviewed presentation protocol.

### Numbered local findings

<a id="finding-f08"></a>

#### F08 — P2 / high confidence in behavior, unresolved intended policy — W09: desktop departure has conflicting control-retention policies

**References:** `apps/web/features/bot-desktop/desktop.tsx:22–67`, `apps/web/app/router.tsx:120–130`, `apps/server/src/bot-desktop/desktop-api.ts:89–109`, `apps/server/src/bot-desktop/desktop-control.ts:55–73,94–117`, `apps/docs/content/concepts/workspaces.mdx:124–131`.

**Observed states and sequence:** Start bot-owned, request owner control, delay PUT, and navigate away. Cleanup reads the still-bot holder ref and sends no hand-back. The late request then persists owner control after the component is gone. In contrast, departure after a rendered owner response sends automatic hand-back. The real exported component reproduction emitted only `["owner"]` in the delayed case. Server persistence and waiter behavior are source-traced, not proved by the fake HTTP server. This is persistent holder state, not an expiring lease.

**Why this is P2 rather than a confirmed stranded-control bug:** The implementation comment says leaving hands back control. However, the user-facing documentation explicitly says, “The bot stays paused until you hand back control, even if you close the page or the server restarts.” Continued owner control therefore satisfies the documented safety policy. Normal cleanup implements the opposite policy. The reproduced timing dependence is real, but a consistent intended invariant has not been established. Do not label every retained owner state an unwanted liveness failure or prescribe unconditional release.

**Candidate invariant and reachability:** Departure must follow one specified control-retention policy independent of whether an outstanding claim response rendered. The public Back link remains enabled while claiming. Requests have no cancellation/ownership compensation; SSE disconnect only unsubscribes. If explicit hand-back is the intended contract, normal post-acquisition departure is instead the violating branch. No unauthorized action or cross-client takeover is demonstrated here.

**Recovery and impact:** Owner holder state persists across restart, which rebuilds its workspace hold. Returning and choosing Hand back recovers it. No server lease expiry exists. Scope is one bot desktop's pause/retention behavior; safety versus liveness impact depends on the policy decision.

**Tests and deterministic proposal:** No existing frontend lifecycle test covers this transition. The executed deferred-PUT component test proves the two departure schedules can differ; it does not select the correct expectation. Resolve retained-control versus auto-release intent first. Then test both immediate and delayed claim responses through the real component and route seam. If retained control is intended, both departures must preserve it. If auto-release is intended, a late claim must be followed by an ordered, ownership-aware release. Cover multiple tabs before adopting cleanup that can release another client's claim. Aborting fetch alone cannot undo a committed PUT.

<a id="finding-f16"></a>

#### F16 — P1 / high confidence — W11: prior question draft can answer the successor question

**Evidence and sequence.** Draft text and selected strings initialize once in `apps/web/features/jobs/job-question-answer.tsx:65–74`; submit uses the *current* `question.id` at 76–87. The job panel renders this component without a question key at `apps/web/features/jobs/jobs.tsx:494–500`. While Q1 is visible, type an answer or select a multi-choice option. Another owner client or reporter answers Q1; the job resumes and asks Q2 before the next three-second list fetch. That fetch goes directly from Q1 to Q2 (no intermediate null render), retaining the same React component. The owner submits the retained text/selection under Q2's ID. For options, the same label must exist in both questions; free text needs no overlapping options.

**Reachability/invariant.** The public job question/answer protocol permits this sequence. `apps/server/src/jobs/jobs.ts:1493–1503` creates a fresh random question ID; answer transaction at 1537–1555 clears pending and queues the continuation. The reporter-first path explicitly allows another actor to answer. There is no guarantee a polling browser observes the intermediate empty question. Drafts must belong to a question identity, not only job identity. Server's pending-ID guard at line 1540 protects outdated requests, but this frontend attaches the *new* ID, so it can accept old semantic content as a valid new answer.

**Observed/recovery/risk.** Real component reproduction rerendered Q1→Q2 after selecting `keep` and observed POST `{questionId:'q2',text:'keep'}` without selecting an answer to Q2. That verifies draft leakage, not a complete model-driven end-to-end run. An explicit submit is still required: not automatic or a security bypass. It can nevertheless steer a coding job with an answer to the wrong decision. Reload/remount clears the stale draft; an already accepted answer is durable and not undone by retry/restart. Blast radius is one job's subsequent work.

**Test/fix boundary.** Existing cost/failure-card and list-invalidation tests do not exercise changing question identity. Add a DOM test through real JobPanel with two sequential job-list responses: Q1, then Q2 without null; select/type during Q1 and assert blank/unselected Q2 and disabled submit until fresh input. A deferred fetch controls the transition; no real model is necessary. Key the answer editor by question ID (or explicitly reset every draft/mutation field on identity change). The executed direct-component test is already in `frontend-repros.test.tsx` and `frontend-repros.log`.

<a id="finding-f20"></a>

#### F20 — P1 / high confidence — W17: successful save discards edits made while saving

**Evidence and minimal sequence.** Type owner ID A into the public gateway editor; Save; hold PUT response; type owner ID B before response. The owner input remains enabled at `apps/web/features/message-gateways/message-gateways.tsx:529–537`; patch merges B at 670–671. When successful A response returns, `onSuccess` unconditionally replaces draft with `draftOf(next.config)` at 652–654. `aria-busy` at 707 is only metadata, and Save/Reset disabling at 630–635 does not lock inputs. This does not require multiple requests or external clients.

**Invariant/outcome.** A server acknowledgement must adopt its submitted version without silently deleting later local edits. The real exported MessageGatewaySettings reproduction gates PUT, observes input B, returns A, then observes input overwritten to A. Output: `W17 observed: second edit overwritten with first`. Reproduction imports unmodified code and mocks only HTTP, not editor logic. Source and runtime agree. No B request was sent; therefore refresh/restart cannot recover B. Retrying after the response resubmits whichever values remain (A), not the lost B.

**Severity and coverage.** This is local unsaved configuration data loss with ordinary latency; editing owner/access/alias fields is supported while pending. It is not proof of unauthorized gateway access, because saved configuration is still the submitted A. Scope is that editor/account, and the loss is usually recoverable by manually retyping if noticed. Existing `apps/web/features/message-gateways/message-gateways.dom.test.tsx:9` checks invalid input, status refresh and failed save retention, but deliberately never returns success while a newer edit exists.

**Deterministic regression/boundary.** The executed reproduction is the exact deferred-response regression seam. Reverse its observed assertion to require either B preserved and dirty after adopting A as authoritative, or fields disabled throughout pending save. Own the version boundary in `useGatewayEditor`: disable editing while save settles, or compare draft/submitted generation before replacement. No server transaction/FSM framework is needed for this purely local adoption invariant.

<a id="finding-f24"></a>

#### F24 — P2 / medium confidence, not reproduced — W13: update apply can adopt a different candidate than the preview

**Preconditions/sequence.** An installed shared skill has update candidate commit B. Open Review update and fetch B's preview. Upstream moves to C. Before pressing Update, another authenticated client invokes the public update check, or the daily update-check layer runs when due. `apps/server/src/skills/skill-installer.ts:368–399` upserts candidate per skill; `apps/server/src/skills/skills-api.ts:169–184` publicly exposes check, preview and apply. No visible refresh of the already-open preview is required. Click Update in that stale sheet.

**Evidence/invariant.** Frontend fetches a candidate at `apps/web/features/skills/skill-install.tsx:497–501` but sends only skill ID at 503–505. Server `upstreamOf` rereads `updates` at `apps/server/src/skills/skill-installer.ts:441–470`; both pending (474–480) and apply (482–512) call it independently. Thus code selects C at apply time, not necessarily B. Review ought to authorize the displayed candidate, rather than arbitrary later instructions. Initial installation already pins `found.commit`, so the inconsistency is specific to update review, not discovery.

**Outcome vs assumptions.** Different-version selection is source-supported; a full crossed-check scenario and product requirement that review must pin a version were not executed/independently confirmed, so this stays P2. There is no JS interleaving claim within one synchronous operation: the preview, external check and apply are separate requests with durable writes between them. No attacker without write control over the public upstream repository is assumed. The blast radius is shared instructions/documents and bots using that skill; ordinary likelihood is low, requiring an intervening check. Applied content survives restart; the existing learned-change log permits revert. Retry can select another current candidate rather than recover the originally reviewed one.

**Existing-test gap and proposal.** `apps/server/src/skills/skill-installer.test.ts:238` checks preview/apply of one candidate and revertible recording, not preview B/check C/apply. Use its real `setup()` and fake GitHub seam: install A, push B/check/pending, push C/check, apply, then compare returned instructions/commit to the saved preview. Expected safe behavior is apply B or conflict requiring another preview; predicted actual is C. A DOM companion can gate candidate GET and avoid invalidating its cache while check advances. This experiment is proposed only. Justified boundary change: include expected candidate commit/digest in apply and enforce it atomically against candidate adoption (or fetch/apply that immutable commit). Do not solve this with a generic frontend reducer alone.

### Limits and structural recommendations

The report intentionally does not propose generic state-machine rewrites. F08 needs an authority-lifetime boundary; F16 needs question-owned draft lifetime; F20 needs submitted-version-aware draft adoption; F24, if confirmed, needs a reviewed-candidate condition at the server boundary. Existing bounded bulk operations and pending-only decision transactions are preserved rather than replaced.

Coverage omissions: no complete browser/noVNC session, live responsive/focus test, download behavior across browser engines, real reporter/model timing, network-service integration, or S01 theme-remount experiment. Frontend library internals were not exhaustively audited. Server boundary tests do not substitute for browser coverage. All P1 consequences distinguish directly reproduced frontend behavior from source-traced durable/server outcomes.
