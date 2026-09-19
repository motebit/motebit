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

A GitHub security advisory tells the users of a released package which versions to move off. Both weaknesses below are in `@motebit/relay`, which is marked private and has never been published: there is no version anyone installed, and nothing for a user to upgrade. Filing an advisory against a package nobody depends on would be a notice that looks like diligence without doing its work.

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

## Known and open

We do not only publish what we have finished. Weaknesses we have found and not yet closed are tracked in the open, without the detail that would help someone use them before we do:

- [#702](https://github.com/motebit/motebit/issues/702) — no shipped client can reach the key-rotation route, so rotating an identity's key currently removes it from the relay.
- [#703](https://github.com/motebit/motebit/issues/703) — a routine daemon shutdown discards an identity's guardian and key state along with its discovery record.
- [#704](https://github.com/motebit/motebit/issues/704) — a federated peer can set a local identity's key from a field its signature does not cover.
- [#705](https://github.com/motebit/motebit/issues/705) — two routes are unauthenticated on a deployment configured without an operator token.
- [#706](https://github.com/motebit/motebit/issues/706) — a key history can be recorded in an order a verifier will reject.
- [#707](https://github.com/motebit/motebit/issues/707) — an identity holding no key at all is claimable at the public registration doors.
