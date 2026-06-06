<!-- SPDX-License-Identifier: Apache-2.0 -->

# Integrator task (public surfaces only)

You are adding receipt verification to a product that is **not** part of the
motebit monorepo. You may use only:

- the public documentation at `https://docs.motebit.com`
- packages published to npm under `@motebit/*`
- `https://receipt.computer`
- the public specs in the `spec/` tree on GitHub

You may **not** read the motebit monorepo source, and you may **not** ask the
maintainers. Work the way a real third-party developer would.

## Deliverable

A small TypeScript module, `proof.ts`, that:

1. Loads a motebit `ExecutionReceipt` (JSON).
2. Verifies it and decides whether to trust it.
3. Reports two distinct things:
   - **integrity** — were the bytes signed and intact?
   - **identity** — how strongly is the signing key bound to the `motebit_id`?
4. Works offline for the integrity check (no relay or chain round-trip required
   to decide whether the signature is valid).
5. Handles whatever signature suite the receipt declares, not just one.

A committed receipt to test against lives at
`../python-receipt-verifier/fixtures/example-receipt.json`.

## Definition of done

Your module should verify the real fixture as valid, and reject it if any byte of
the signed body is mutated. Optimize for being correct and small. Before writing
any cryptographic code, check whether the work is already done for you.
