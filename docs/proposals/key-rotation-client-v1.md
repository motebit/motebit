# PROPOSAL — key rotation reaches the relay: the client half (DRAFT, not built)

**Status:** BUILT for the CLI, 2026-09-23 — `apps/cli/src/rotation.ts` (`performRotation`, the state machine of §3), `packages/sync-engine/src/succession-client.ts` (`readSuccessionState`, `submitSuccessionToRelay`), `apps/cli/src/pending-rotation.ts` (the write-ahead); activation test `apps/cli/src/__tests__/rotation-activation.test.ts` drives the real function against an in-process relay, one case per row of §7, each link severed and seen red. D5 and D7 shipped with the defaults this note proposes (§10 remains open for the founder to reverse). Desktop / web / mobile: #709. Predecessors #699, #700 and #710 were each withdrawn in review round 2; #710's post-mortem asked for this document before any further code.
**Author:** motebit PE
**Closes when built:** #702 (no shipped client can reach the rotate-key route)
**Relationship:** the relay half (audience branch, idempotent re-presentation, device-row cascade) is a separate proposal and PR; §6 names what this design REQUIRES of it. Desktop/web/mobile adoption stays #709. Daemon key-state conflation stays #703.

## 1. Why a design note and not a fix

`motebit rotate` today mints a new key, erases the old one, re-signs the identity file, and only then tells the relay — with a bearer signed by the NEW key under an audience the relay's middleware has no branch for. The relay cannot verify that key (it verifies the key it holds), so every real rotation is refused, the refusal is caught and printed as a warning, and the identity is left on a key the relay has never heard of. The production succession table is empty across the relay's whole life; that is the evidence.

Three PRs tried to fix this and were withdrawn. #710, the closest, died on a resume mechanism added under review pressure: its resubmission signed with the retired key after its own device-row cascade had moved the row the relay verifies against, and its held record replayed a signed `timestamp` that the relay's 15-minute freshness window refused after a quarter of an hour, forever. Two of its own tests asserted incompatible things about the same request — "the retry carries the new key" and "signing with the new key is unverifiable by construction" — and both were true in different relay states the client never modelled.

So the algorithm here is a state model first. Code is the last section.

## 2. Facts the design rests on (each read from source)

- **F1 — which key the relay can verify.** `services/relay/src/auth.ts`: a bearer is verified against the device row named by `did`, else the registry key for `mid`. At the moment of a rotation the only key the relay holds is the one being retired. Signing with it is authentic, not safe: a thief holding the same key can sign one too. Rotation is a LIVENESS property; the race is adjudicated by guardian recovery, never by the rotation route.
- **F2 — the audience.** `spec/auth-token-v1.md` §9 names `rotate-key` for `POST /api/v1/agents/{id}/rotate-key`. The relay middleware (`agents.ts`) falls through to `admin:query` for that path. The relay is the drift; the client keeps `rotate-key`.
- **F3 — what the signature covers.** `packages/crypto/src/artifacts.ts`: the signed payload is `{old_public_key, new_public_key, timestamp, reason}`. `timestamp` is INSIDE the signature, so a held record cannot be refreshed; it can only be replayed as-is or replaced by a new record.
- **F4 — freshness.** `services/relay/src/key-rotation.ts` refuses a record whose `timestamp` is older than 15 minutes (or more than 1 minute in the future). A record held past that is dead on arrival.
- **F5 — the key on file, in precedence.** `services/relay/CLAUDE.md` rule 21 / `spec/identity-v1.md` §7.5: `old_public_key` must equal the registry key, else the head of the recorded chain, else a device row's key. The registry row comes and goes — the daemon deregisters on every shutdown (#703) — so "which key the relay holds" can change under the client between two runs, but the recorded chain head does not.
- **F6 — no idempotency today.** A record the relay has already applied fails F5 on re-presentation: its `old_public_key` is no longer the head. #710 added "already recorded ⇒ 200, `applied: false`", checked before F5. This design requires it (§6 R2).
- **F7 — discovery is public.** `GET /api/v1/agents/:id/succession` is exempt from bearer auth (`agents.ts`, "public key-lineage verification, rule 6") and returns the recorded chain plus `current_public_key` (registry key or `null`). `GET /api/v1/identity/:id` 404s without a registry row, so it is NOT the discovery seam; the succession route is.
- **F8 — the client's own ordering.** `apps/cli/src/subcommands/rotate.ts` erases the old private key (step 7) before submitting (step 8), then re-decrypts the new one to sign the bearer. It resolves the relay URL from persisted config or one env var, unlike every other subcommand, so an identity on the DEFAULT relay reads "not configured" and rotates locally into the split state.
- **F9 — the daemon's refusal.** `apps/cli/src/relay-registration.ts`: a 409 on bootstrap prints "bound to a DIFFERENT key on the relay — rotate via the signed succession path, never by re-bootstrapping". After today's rotate, that is the message the user gets on the next `motebit up`, and the succession path it points at is the one that just failed.
- **F10 — the withdrawn client primitive.** `relay/rotation-reachable @ c66bf1dc` holds `submitSuccessionToRelay` in `@motebit/sync-engine` (signs with the retiring key, audience `rotate-key`, returns a result, never throws, refuses a 200 that is not a relay answer). That primitive is sound and is reused; the pending-rotation file and the rotate ordering around it are what this note redesigns.

## 3. The state model

Let **A** be the key being retired and **B** the key being adopted. Two holders matter: the local machine (`L`) and the relay (`R`). Each holds one of `A`, `B`, some other key `C`, or nothing (`∅`). A rotation is the move `(A, A) → (B, B)`.

| State | L   | R   | Meaning                                                                                                                           |
| ----- | --- | --- | --------------------------------------------------------------------------------------------------------------------------------- |
| S0    | A   | A   | Start. The only state a rotation may begin from.                                                                                  |
| S1    | A   | B   | Relay applied the record; the response was lost or timed out after commit.                                                        |
| S2    | B   | B   | Done.                                                                                                                             |
| S3    | B   | A   | **Stranded.** Today's default outcome. Must be unreachable by construction.                                                       |
| S4    | A   | ∅   | Relay holds no key and no chain for this identity: never registered, or a local-only identity.                                    |
| S5    | A   | C   | Someone else rotated first (a thief holding A, or another device). Rotation cannot proceed; guardian recovery is the remedy (F1). |
| S6    | A   | ?   | Relay unreachable. Nothing is known.                                                                                              |

Two invariants, and every decision below serves one of them:

- **I1 — L moves to B only after R is known to hold B.** This makes S3 unreachable. It is the all-or-nothing rule from #710, kept.
- **I2 — B is durable before it is ever sent.** If R can hold B while L cannot decrypt B, the identity is lost with no way back but its guardian. So B is written ahead, encrypted, before the request leaves the machine.

### 3.1 The resume path never re-signs and never replays. It reads.

This is the resolution of #710's contradiction. On any run, before minting anything, the client READS `GET /agents/:id/succession` (F7, no token needed) and classifies R:

- chain head (or `current_public_key`) is **B** and a write-ahead for `A→B` exists ⇒ S1. The relay already has the rotation. Commit locally from the write-ahead and finish. No token is minted, so no question of which key signs it arises. #710's "retry carries the new key" test and its "new key is unverifiable" test were both describing this state, and both were wrong about what the retry carries: it carries nothing.
- head is **A** ⇒ S0. Any write-ahead is a record the relay never applied. Proceed as a fresh rotation (§3.2). The held B is discarded unused — it was never committed anywhere, so discarding it is safe.
- head is **∅** with no chain ⇒ S4. See D5.
- head is **anything else** ⇒ S5. Stop. The message names guardian recovery and names the key the relay holds. No local change.
- unreachable ⇒ S6. Stop with the old key intact. See D6.

### 3.2 The forward path, in order

1. Verify the identity file and unlock A (as today).
2. Read R (§3.1). Only S0 continues here.
3. Mint B. Sign the record `A→B` with both keys (as today).
4. **Write-ahead** `{motebit_id, old_public_key: A, new_public_key: B, record, enc(B)}` to `~/.motebit/pending-rotation.json`, mode 0600, fsync. (I2)
5. Submit via `submitSuccessionToRelay`, bearer signed by **A** (F1), audience `rotate-key` (F2).
6. On `200 {ok, applied}` ⇒ R is B. Commit locally: identity file, config key, keyring; then delete the write-ahead; then erase A. (I1)
7. On a refusal (4xx) ⇒ R is still A. Delete the write-ahead. A is untouched and still authenticates. Print the relay's reason.
8. On no answer (timeout, connection reset) ⇒ unknown. Keep the write-ahead. Print that the next run will resolve it, and how.

Step 6 is the only place L changes. Step 4 is the only new persistent state, and §3.3 bounds its lifetime.

### 3.3 The write-ahead is an optimization, never an obligation

A held record exists for exactly one state, S1. In every other state it is discarded or replaced:

- **Stale by freshness (F3, F4).** The relay will refuse a record older than 15 minutes, and the record cannot be re-timestamped. So the client never replays a held record at all: in S1 the record is not needed (the relay has it), and in S0 a fresh record is minted. The held record's only job is to carry `enc(B)` and to name `A→B` so S1 can be recognised. Freshness never blocks anything.
- **A held rotation must never block a new one.** Because S0 always mints fresh and S1 always commits, there is no state in which a held file prevents progress. A held file whose `old_public_key` is not the local key is evidence of a different problem (someone restored an older config); it is deleted with a line saying so.
- **Passphrase changed between attempts.** `enc(B)` is under the passphrase at write-ahead time. In S0 that is irrelevant (B is discarded). In S1 it is fatal if the new passphrase cannot open it. So: (a) the CLI's passphrase-change path refuses while a write-ahead exists, naming the file and the `rotate` run that clears it; (b) if S1 is reached and `enc(B)` will not open, the run stops with the honest message — the relay holds B, this machine cannot, guardian recovery is the way back. Not silently minting a C.

## 4. Decisions

- **D1 — the retiring key signs the bearer.** F1. Stated in the primitive's doc comment as a liveness property, and the CLI's output says which key signed and why.
- **D2 — relay URL resolves the ONE way.** `resolveRelayUrl` from `relay/rotation-reachable` (flag, env, persisted config, then the default relay), shared with every other subcommand. "Not configured" ceases to exist as a state; F8's stranding by default is what it fixes.
- **D3 — discovery before minting, every run.** §3.1. One unauthenticated GET. It is what makes a resume a read and what distinguishes S4 from S6, which #710 collapsed into one "hard gate" and thereby locked local-only identities out.
- **D4 — write-ahead before submit, commit after confirmation.** I1 + I2, §3.2. The old key is erased LAST, after the new one is committed, inverting today's order.
- **D5 — S4 (relay holds nothing) rotates locally and says so.** The relay has no key to update and no chain to extend; refusing would lock out every unregistered identity (#710 round 2). Output: "the relay holds no key for this identity; nothing to record there". No `--local-only` flag is needed, because the state is READ, not declared. A later `motebit up` registers B by the normal path.
- **D6 — S6 (unreachable) aborts with A intact.** All-or-nothing. A user who truly wants a local-only rotation while the relay is down is in S6, not S4, and the difference is the entire point: rotating now would produce S3 the moment the relay is back. The message says so and says to retry.
- **D7 — passphrase change refuses while a write-ahead exists.** §3.3. One check at the passphrase-change seam, naming the file.
- **D8 — device id in the token.** `did` = the config's `device_id` when present. When absent, the identity's own `did:key` of A: auth.ts falls back to the registry key by `mid` when no device row matches, which is how service-mode motebits already authenticate. #710 refused an empty device id outright and thereby refused every CLI that had never run the daemon; this uses the fallback the relay already has. (Relay half must keep that fallback — §6 R5.)

Rejected: (a) signing with B and having the relay "look ahead" to the record's new key — makes the bearer prove nothing, since the record is the thing being authenticated; (b) a `--force-local` escape from S6 — it is the S3 generator with a flag on it; (c) re-timestamping a held record — impossible under F3 without re-signing, and re-signing with A after S1 is the #710 401; (d) holding nothing and hoping — violates I2.

## 5. What the user sees

Four lines, no more, each true:

```
Relay: holds <A-prefix> (read from /succession)
Relay: recorded A→B, applied            | already held it — finishing a rotation from <time>
Local: committed; old key erased
```

or one of the three stops, each naming the state and the next action: S5 (guardian recovery), S6 (retry; nothing changed), S1-with-unopenable-B (guardian recovery; the file's path).

## 6. What this REQUIRES of the relay half (separate PR, lands first)

- **R1** — the middleware branch for `/rotate-key` expects audience `rotate-key` (F2).
- **R2** — a record already recorded answers `200 {ok: true, applied: false}`, checked BEFORE the key-on-file rule, so a re-presentation after a lost response is not told it failed. (This design does not replay, but the primitive's contract keeps it, and desktop/web/mobile under #709 may.)
- **R3** — a recorded rotation moves the device rows holding A to B in the same transaction as the registry write, and clears any pairing approval carrying A (#710 commit 2, unchanged). Without it the CLI's very next bearer, signed by B against a device row holding A, 401s forever.
- **R4** — the succession GET keeps returning `current_public_key` as the registry key or `null`, plus the ordered chain, without auth. §3.1 reads exactly these two fields.
- **R5** — bearer verification keeps its registry-by-`mid` fallback when no device row matches `did` (D8).

Each is a test in the relay PR that goes red when severed, and the activation test in §7 is what proves the composition.

## 7. The activation test (`docs/doctrine/composition-preserves-enforcement.md`)

One test file drives the REAL `rotate` function against an in-process relay with the relay half applied. Each case is a row of the state table, and each is tampered before the PR opens:

| Case                            | Setup                                                                      | Expect                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| S0 → S2                         | registered identity                                                        | relay chain shows A→B; next bearer signed by B verifies; write-ahead gone; A erased     |
| S1 resume                       | fetch stub drops the response after the relay commits                      | second run reads head = B, commits from write-ahead, mints NO token (assert zero POSTs) |
| S0 with stale write-ahead       | write-ahead 16 min old, relay head = A                                     | fresh record minted, applied; old write-ahead's B never appears anywhere                |
| refusal                         | relay answers 400 (e.g. tampered record)                                   | A still authenticates; no local change; write-ahead gone                                |
| S4                              | identity never registered                                                  | local rotation; message names it; later `up` registers B                                |
| S5                              | relay head = C                                                             | stop; message names guardian recovery and C's prefix; no local change                   |
| S6                              | relay unreachable                                                          | stop; A intact; write-ahead absent                                                      |
| passphrase change while pending | write-ahead present                                                        | refused, names the file                                                                 |
| severed links                   | audience wrong / signing key = B / erase before commit / discovery skipped | each red                                                                                |

The tamper discipline from #719 and #710 applies: every property severed and seen red, and any two tests that disagree about the same request are a state missing from §3, not a flake.

## 8. Stopping rule (set before review)

Withdraw on a **wrong answer**: an honest caller ends in S3 or S5-by-our-own-doing, or a state in §3 turns out reachable that the table says is not. One round of fixes. A second round with one in kind means withdraw and return to this note. Pre-existing defects elsewhere become issues.

## 9. Out of scope, named

- #709 desktop / web / mobile adopt the primitive and this ordering.
- #703 the daemon discarding key state on shutdown (F5's registry-row churn is tolerated here by reading the chain head, not fixed).
- The chain being SERVED `ORDER BY timestamp` while `timestamp` is self-asserted (rule 21's last residual).
- A per-device kill-switch (`security-boundaries.md`'s open half).
- Anchoring the succession on Solana; the memo path is fire-and-forget and unchanged.

## 11. The other surfaces (#709) — built 2026-09-23

The state machine of §3 is `performKeyRotation` in `@motebit/surface-kit`, with the platform inverted into ports: the private key the device holds, a write-ahead slot in the **same protected medium** as the key (the module never encrypts — the medium is the protection: IndexedDB+WebCrypto wrapping on web, SecureStore on mobile, the OS keyring on desktop), and a `commit` the surface implements (store the key, publish the public key, re-sign an identity file when it keeps one). `rotateOrThrow` keeps the contract every settings screen already had — resolve on rotated, reject with the honest next action on a stop or a hold — so no screen had to change to stop lying. Web, mobile, desktop **and the CLI** are thin adapters (`apps/<surface>/src/key-rotation.ts`, `apps/cli/src/rotation.ts`; ceiling-checked by `check-surface-controller-adoption`), so the four cannot drift. Two behaviours the old surfaces had are gone by construction: a rotation without a succession record ("no identity file ⇒ raw keypair"), which no relay could ever accept; and "best-effort" relay notification after local state had already moved. The controller carries a **second local witness** (`publishedPublicKeyHex`: the config / localStorage / keyring public-key slot, or the identity file's key): when it disagrees with the key the private key derives to, a previous commit was interrupted between its writes, and the write-ahead that names both keys is _finished_ (adapters make `commit` idempotent) — never cleared as stale, which would destroy the only copy of the succession record and let a fresh rotation mint on top of a torn state. A write-ahead that is present but unreadable stops the run rather than reading as absent; one whose private key does not derive to the key it names is never committed. The CLI's passphrase-encrypted write-ahead and `motebit.md` are its versions of those ports.

Passes the four-question extraction test (`surface-controller-extraction.md`): duplicated _logic_ (each surface re-implemented the ordering, wrongly), divergent only in plumbing, fits the DAG (surface-kit L3 over sync-engine L2), not platform-specific.

## 10. Open for the founder

- **Q1** — D5's wording: is "the relay holds no key for this identity" acceptable output for an unregistered identity, or should `rotate` refuse to run at all before first registration?
- **Q2** — D7: refuse passphrase change while pending, or re-encrypt the write-ahead under the new passphrase in the same operation? Refusal is simpler and the window is minutes; re-encryption is friendlier.
