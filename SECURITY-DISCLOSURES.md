# Security disclosures

[`SECURITY.md`](SECURITY.md) asks researchers to tell us about a weakness before they tell everyone. This file is the other half of that bargain: what we found in our own code, what it would have allowed, and what we did about it.

It exists because of the posture the architecture already commits to. [`docs/doctrine/operator-transparency.md`](docs/doctrine/operator-transparency.md) says an operator proves its posture rather than declaring it, and applies the disappearance test to every claim: if the operator vanishes, the claim must survive. A disclosure that lives only in a dashboard fails that test. This file is in the repository, so it is in every clone.

## What is recorded here

A weakness in code we wrote, which we fixed, where an attacker could have reached something that was supposed to be out of reach. One entry per weakness, written after the fix is live, and covering:

- what the code did, and what it should have done;
- who could have exploited it, and what they would have needed;
- when it was fixed, and which production release carries the fix;
- **what we checked afterwards, and what the check could not see.**

The last point is the one that makes the rest worth reading. "We found no evidence" is only as strong as the search, so each entry says what the search was.

## Why there is no published advisory

A GitHub security advisory tells the users of a released package which versions to move off. Every weakness below is in `@motebit/relay`, which is marked private and has never been published: there is no version anyone installed, and nothing for a user to upgrade. Filing an advisory against a package nobody depends on would be a notice that looks like diligence without doing its work.

The relay is a service we operate. The honest artifact for a service is this record, alongside the transparency declaration at [`services/relay/PRIVACY.md`](services/relay/PRIVACY.md). If a weakness ever reaches a published package, it gets an advisory as well, because then there is someone with a version to move off.

---

## 2026-09-19 — a stranger's device could hold an identity's key

**Fixed in [#693](https://github.com/motebit/motebit/pull/693), live in relay release v959.**

The relay verifies a signed bearer token against the public key recorded for the device the token names. Adding a device record is therefore equivalent to minting that identity's tokens.

Both public registration doors are meant to refuse a key an identity has never held. One of them, `register-self`, checked for a conflict only on the _same_ device id, so presenting a **new** device id under an existing identity was accepted with any key at all. The party who did that then held ordinary owner tokens for someone else's identity — including the ones that move money.

An in-process probe confirmed it before the fix, through both public doors, and a cross-identity device-id takeover worked as well. Identities known only to the agent registry were unprotected.

Both doors now answer to one rule, in `services/relay/src/device-registration-guard.ts`: once an identity holds a key, a public registration must present a key it already holds. Adding a device under a _new_ key is the authenticated pairing flow's job; replacing one is key rotation's.

**What we checked, 2026-09-19, against the production database.** A device record written by this weakness would sit beside the real one under the same identity, carrying a different key. There were **none** — every identity's device records agree on a single key — and **no** device id appeared under more than one identity.

**What that check cannot see.** It compares an identity's records against each other. If an identity's records all carry one key, nothing in the data says whose key it is. The check finds a stranger's key sitting next to the owner's; it cannot find one that stands alone.

---

## 2026-09-19 — key history could be written under someone else's identity

**Fixed in [#701](https://github.com/motebit/motebit/pull/701), live in relay release v961.**

A key succession record proves a rotation from one key to the next. Its signed body names the two keys and **not** the identity, so the record alone cannot say whose history it belongs to. The route had to supply that, and did not: it never compared the caller to the identity in the path, and the check that a record continues from the identity's stored key was skipped whenever that stored key was missing or empty.

Neither of those is an unusual state. The daemon deregisters on every shutdown, which removes the stored key, and an operator registration that names no key writes an empty one.

Any authenticated party could therefore record an invented chain of keys under another identity. The damage is wider than a takeover: the relay serves that chain from its public succession route and from the identity-binding endpoint that third parties use to check who signed something. A verifier walking a poisoned chain no longer arrives at the identity's real key, so the identity's own receipts stop verifying.

The same change closed a second door. Pairing's key-transfer route takes no bearer token — it is reached by whoever completed the pairing — and it wrote _any_ key to the newly paired device's record, which is again equivalent to minting that identity's tokens. It now writes only the key that transfer was approved to carry.

**What we checked, 2026-09-19, against the production database.** The table that would hold a planted chain is **empty**: no succession has ever been recorded on this relay, so this was never exploited. Zero is also consistent with a separate defect we found while fixing this one — no shipped client can currently reach the rotation route at all ([#702](https://github.com/motebit/motebit/issues/702)) — which is tracked and not yet fixed.

**What that check cannot see.** It is a point-in-time read. A record written and deleted before we looked would leave nothing behind; the relay does not keep an append-only log of this table.

**A note on sequence.** The repository is public, so the pull request that fixed this described the weakness before the fix reached production. For a public codebase that window is unavoidable — the fix cannot be reviewed without showing the bug — but it is real, and it is why the deployment follows the merge immediately rather than on a schedule.

---

## 2026-09-21 — a peer of the relay could set any identity's key

**Fixed in [#713](https://github.com/motebit/motebit/pull/713), live in relay release v962.**

Relays federate by exchanging revocation events over a heartbeat. Each event carries the sending relay's signature, and the receiving relay verified it and then applied the event: `key_rotated` wrote the named public key into the agent registry, `agent_revoked` set the revoked flag, `credential_revoked` denied a credential.

The signature was never a boundary. Peering is not an authorization — `propose` and `confirm` are two unauthenticated calls, and a peer is admitted on a signature over a nonce the relay has just handed it, made with the key it supplied. The peer and the author of the events are the same party, so a valid signature was something anyone who could reach the relay could produce for themselves. The key in `key_rotated` was not covered by that signature either, but that is the smaller half: even a signed field would not have said the sender was entitled to speak about the identity it named.

An identity re-keyed this way is served from discovery, from the identity-binding endpoint third parties read, and into the anchored identity log. Revoked, it drops out of discovery and can no longer migrate — without the signed, append-only moderation record the operator's own revocation writes.

The receiving side now writes no identity state from a peer's feed at all. Every row in that table was admitted by a door with a named authorized principal — the identity itself, its designated guardian, the operator under a signed record, or a verified migration — and a peer is none of them. `credential_revoked` is refused on the same ground: the relay already states that only a credential's subject or issuer may revoke it, and a peer is neither.

**What we checked, 2026-09-21, against the production database.** A peer that ever reached the active state leaves a durable record — the only deletion is on a failed handshake, and a peer removing itself only marks the row removed. There are **two** such records: our own staging relay, long since removed, and a stale self-reference. No third party has a record. No identity is revoked, none carries a key its own devices do not attest, and no credential is marked revoked from any source.

**What that check cannot see.** There is no append-only log of the registry table, so the key comparison is a point-in-time read: a change written and overwritten before we looked would leave nothing behind. Volume backups were not examined. And the argument that an admitted peer always leaves a record is drawn from the current code, not proved over the whole history.

**What this fix does not do.** It blocks unauthorized inbound changes; it does not give the protocol an authenticated way for one relay to tell another about a real revocation. That is unbuilt, tracked in [#714](https://github.com/motebit/motebit/issues/714), and it means a credential legitimately revoked on another relay does not become revoked here. No credential we currently hold depends on that path — all of them were issued by, and belong to, identities this relay serves — and local revocation is unaffected.

---

## 2026-09-21 — anyone could revoke anyone's credential

**Fixed in [#719](https://github.com/motebit/motebit/pull/719), live in relay release v963.**

The route that revokes a credential states its rule in its own refusal: only the credential's subject or its issuer may do it. It decided that rule by comparing the caller to the identity named in the request path — a value the caller chooses — and never compared it to the credential named in the body. Naming yourself in the path satisfied the subject test for any credential, including one belonging to someone else.

Authentication was not a barrier either. The route's audience is resolved by matching the path against `/credentials`, which `revoke-credential` does not contain, so it fell through to the general audience any agent mints from its own key.

Knowing a credential's identifier is the only other requirement, and identifiers are not secret to a counterparty: presenting your credentials is the ordinary way to be trusted, and a presentation carries them. A revoked credential is dropped from the hardware-attestation score the relay computes and is refused if resubmitted. The table has no foreign key, so an identifier could also be denied before it was ever issued.

Authorization now resolves the credential first and binds to it. The path segment must name the credential's holder; it keeps the route's meaning honest and it does not authorize. Two further faults went with it: the issuer check consulted whichever device row happened to come back first from an unordered query, so a legitimate issuer with more than one device was refused unpredictably; and the revocation record was filed under the identity the request named rather than the credential's actual holder.

**What we checked, 2026-09-21, against the production database.** The revoked-credential table is **empty** — no rows, from any source, across the relay's life. This was never exercised, by anyone. Forty-six credentials are held, every one of them issued by and belonging to identities this relay serves.

**What that check cannot see.** Emptiness is a strong answer here because the table is append-oriented and nothing in the relay deletes from it — but it is still a point-in-time read, and a row written and removed by some path we have not identified would leave no trace.

**How it was found.** Not by a report. It came out of writing the tests for the rule while closing the weakness above, which is the part worth recording: the rule had two tests and neither reached it. One sends no token; the other uses the operator token, which takes a bypass and never evaluates the subject test at all. A rule enforced in one place, skipped in another, and asserted nowhere is invisible until someone writes the test that names its principals.

---

## 2026-09-25 — anyone could write into another identity's synced conversations

**Fixed in [#771](https://github.com/motebit/motebit/pull/771), live in relay release v973.**

A device keeps its conversations and events in sync over a websocket to the relay. The socket names the identity in its path and proves itself with a signed token, which it can send in two ways: as a message after connecting, or in the connection URL.

On the URL path, the relay started checking the token and then kept handling messages while the check was still running. The only guard against unauthenticated messages was a flag set on the other path, so on this one it was never set. Anything the client sent straight after connecting was acted on as if it came from the identity named in the path. That covered pushed conversations, messages and events, task claims and command responses.

So anyone who knew an identity's id, which is public, and held a token signed by **any** key at all could write into that identity's synced conversations and events. The relay would pass them on to the identity's own connected devices before it finished checking the token and closed the connection. A synced conversation is part of what an agent reads back as its own history, so this was a way to put words in someone else's agent's memory.

The socket now acts on nothing until the connection is registered, and registration happens only after the token has been verified. None of our own clients send a token in the URL, so none of them behaved differently.

**What we checked, 2026-09-25, against the production database.** An injected conversation would carry an identifier and an identity chosen by whoever sent it. All 77 synced conversations have the identifier shape our clients generate, belong to identities that hold device records, and carry no future timestamps. Of 20,543 events, one belongs to an identity with no device record: an identity-creation event from March, written before device records existed.

**What that check cannot see.** Most of it. Rejected tokens are recorded in an auth-event log, but this door never wrote to it, so an attempt left no durable record. A careful attacker would also have used ordinary-looking identifiers, and the check only looks at shape and ownership, not content. We found no sign of exploitation, and we cannot say it did not happen. The fix also makes this door record every refused token, so this question can be answered next time.

**How it was found.** By an adversarial review of an unrelated change to the same socket, a fix for a connection that closes while its token is being checked. The reviewer went looking for other places where the socket's state could change during that same wait, and found this one.

---

## Known and open

We do not only publish what we have finished. Weaknesses we have found and not yet closed are tracked in the open, without the detail that would help someone use them before we do:

- [#705](https://github.com/motebit/motebit/issues/705) — two routes are unauthenticated on a deployment configured without an operator token.
- [#706](https://github.com/motebit/motebit/issues/706) — a key history can be recorded in an order a verifier will reject.
- [#707](https://github.com/motebit/motebit/issues/707) — an identity holding no key at all is claimable at the public registration doors.
- [#714](https://github.com/motebit/motebit/issues/714) — there is no authenticated way for one relay to tell another about a revocation, so revocations do not cross relays at all.
- [#715](https://github.com/motebit/motebit/issues/715) — a setting we publish as an anti-sybil boundary is read by nothing, so the posture it declares is not the posture we hold.
- [#767](https://github.com/motebit/motebit/issues/767) — rotating an identity's key does not end connections already open under the old key.
- [#772](https://github.com/motebit/motebit/issues/772) — the sync socket allows some activity before a connection has proven itself; none of it reaches another identity's data.
