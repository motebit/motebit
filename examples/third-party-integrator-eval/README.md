<!-- SPDX-License-Identifier: Apache-2.0 -->

# Third-party integrator eval

A repeatable check that motebit's **developer experience** holds up for someone
integrating from outside the monorepo — using only the public docs
(`docs.motebit.com`), the published npm packages, and `receipt.computer`.

It is the developer-experience sibling of [`examples/python-receipt-verifier`](../python-receipt-verifier).
That example proves the **spec** is sufficient to implement a verifier. This eval
proves the **docs** lead a competent integrator to the _correct_ path — installing
the published verifier — instead of the expensive wrong one.

## Why this exists

This eval was written after a real third-party integration (a separate product,
a separate agent, no monorepo access) read the docs in good faith and concluded
it should **build its own** receipt verifier. It also assumed a single signature
suite, and read the binding ladder as "identity = an on-chain lookup." Each of
those is a documentation defect, and each is a latent correctness bug in the
wild. This harness turns that one-off finding into a regression gate.

The failure mode it guards against is specific and dangerous: a smart integrator,
reading the docs, **reimplements the permissive floor** rather than `npm install`-ing
it. Every reimplementation is a place canonicalization and suite-dispatch can
drift, and a dent in the protocol-primacy promise.

## The task fixture

`task.md` is the prompt handed to a candidate integrator (human or agent). It is
deliberately constrained to public surfaces only — no monorepo, no asking the
maintainers. The candidate produces a small solution (a file or directory) that
verifies the committed receipt fixture.

## What it scores

`score.py <path>` scans a candidate solution and grades four criteria:

| Criterion              | Pass                                                              | Fail                                                                   |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Uses the floor**     | imports `@motebit/verifier` or `@motebit/crypto`                  | reimplements verification with raw `@noble/ed25519` / `tweetnacl`      |
| **Suite-correct**      | lets the library dispatch, or reads the `suite` field generically | hardcodes one suite's signature encoding (`...-b64-v1` / `...-hex-v1`) |
| **Binding understood** | reads the `sovereign` rung / binding ladder                       | treats `valid` as identity, or calls a chain/relay lookup "the anchor" |
| **Offline**            | no network needed to verify integrity                             | requires a relay/chain round-trip to decide validity                   |

It prints a JSON scorecard and exits non-zero if the candidate fails — so it can
run in CI against a reference "good" solution to catch docs regressions, or
against a captured integration attempt as a one-off audit.

## Run it

```bash
# Score the reference good and bad samples (used as the harness self-test)
python3 score.py samples/good
python3 score.py samples/bad

# Score a real integration attempt
python3 score.py /path/to/candidate
```

## How to use as a docs-regression gate

1. Periodically (or in CI on a docs change) run an agent against `task.md` with
   access limited to the public docs + npm.
2. Pipe its solution into `score.py`.
3. A passing run is evidence the docs still route integrators to the floor. A
   failing run names which doc gap reopened — and which page to fix.

This is an eval, not a receipt: the subject (the docs / the integrator) is not
the signer. See `docs/doctrine/evals-as-attestations.md`.
