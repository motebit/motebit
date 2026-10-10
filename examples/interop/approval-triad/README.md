# Approval → tool call → receipt: a defect/control case

One question, answered from bytes alone: **did the executed tool call match its approval?**

Three signed artifacts describe one gated call:

| File              | Artifact                | Signed by               | What it says                                                           |
| ----------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `approval.json`   | `ApprovalDecision`      | the approver (a person) | "I approve call `approval_id`, with args `args_hash`, in run `run_id`" |
| `invocation.json` | `ToolInvocationReceipt` | the agent               | "I ran call `invocation_id`, with args `args_hash`, in task `task_id`" |
| `receipt.json`    | `ExecutionReceipt`      | the agent               | "Task `task_id` completed"                                             |

There is one control case that matches and five negative cases. Each negative changes exactly one
thing. Two readers check every case: a standalone Python reader and a TypeScript test in CI. Both
must reproduce every field of [`expected.json`](expected.json).

## Run it

```bash
# Python reader (needs only pynacl, no Motebit code)
pip install pynacl
python examples/interop/approval-triad/reader.py        # exit 0 = every field of expected.json reproduced
python examples/interop/approval-triad/test_reader.py   # mutates expected.json one field at a time; every mutant must fail

# TypeScript, using Motebit's own verifiers (from the repo root, after `pnpm install`)
npx vitest run --dir scripts/__tests__ interop-approval-triad

# Re-mint the negatives through the canonical signers and compare byte for byte
npx tsx examples/interop/approval-triad/mint-cases.mts --check
```

Reader output:

```text
case                  verdict   decisive            sig_A  sig_I  sig_R  call  tool  args  verd  order  run   bind
control               MATCH     -                   pass   pass   pass   pass  pass  pass  pass  pass   pass  n/e
n1-args-hash          MISMATCH  args_hash           pass   pass   pass   pass  pass  FAIL  pass  pass   pass  n/e
n2-verdict            MISMATCH  verdict             pass   pass   pass   pass  pass  pass  FAIL  pass   pass  n/e
n3-ordering           MISMATCH  ordering            pass   pass   pass   pass  pass  pass  pass  FAIL   pass  n/e
n4-run                MISMATCH  run                 pass   pass   pass   pass  pass  pass  pass  pass   FAIL  n/e
n5-tampered-approval  INVALID   signature_approval  FAIL   pass   pass   n/e   n/e   n/e   n/e   n/e    n/e   n/e
```

## The claim ceiling

**The link is a join, not a citation.** The receipt does not contain a hash of the approval, and the
approval does not contain a hash of the receipt. The three artifacts are linked only because some
field values are equal:

- `approval.approval_id = invocation.invocation_id` (`call_id`, the join key)
- `approval.tool_name = invocation.tool_name` (`tool_name`)
- `approval.args_hash = invocation.args_hash` (`args_hash`)
- `approval.run_id = invocation.task_id = receipt.task_id` (`run`)

The readers also check that a completed call had an `approved` verdict (`verdict`), and that the
approval resolved no later than the call started: `resolved_at ≤ started_at` (`ordering`).
Timestamps are the signers' own claims. No clock or timestamp authority is consulted.

Signatures are checked against **pinned keys**, never against the `public_key` field inside the file.
The pinned keys are in `expected.json` and `reader.py`.

- approver: `e7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0` (seed bytes 0x21..0x40)
- agent: `79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664` (seed bytes 0x01..0x20)

These are **public demo keys**. Their private seeds are published, so anyone can sign with them. A
valid signature here shows that the bytes are intact under that key. It does not show who signed.

**The outcome is simulated.** No email was sent. The artifacts were minted for this case, not
captured from a live run.

**Binding is not evaluated**, and every case reports `binding: not_evaluated`, never `pass`. Nothing
in this case ties the approver key or the agent key to the `motebit_id` in the files. The agent's
`motebit_id` happens to be derived from its key, but this case does not check that. The approver
key has no offline binding at all. A `MATCH` therefore means "these intact bytes agree with each
other". It does not mean "this person approved and this agent acted".

If any signature fails, the verdict is `INVALID`, and every relation claim is `not_evaluated`.
Relations computed over unauthenticated bytes say nothing.

## The cases

The control files are byte-identical copies of the frozen fixtures in
[`../../python-receipt-verifier/fixtures/`](../../python-receipt-verifier/fixtures/) (`triad-*.json`,
minted by `mint-triad-fixture.mjs`). The CI test checks that they still match. The negatives are
minted by [`mint-cases.mts`](mint-cases.mts) through Motebit's canonical signers
(`signApprovalDecision`, `signToolInvocationReceipt`). They are re-signed by the same demo key, so
each signature is valid and only the relation fails. The exception is N5, which is altered after
signing. In each negative, any file that is not changed is a byte copy of the control.

| Case                   | One change                                                  | Verdict / code           | Shows                                                                | Does not show                                                                               |
| ---------------------- | ----------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `control`              | none                                                        | `MATCH`                  | Three intact artifacts that agree on call, tool, args, run and order | Who holds the keys; that the email was sent; what the args were (only their hash is signed) |
| `n1-args-hash`         | `invocation.args_hash` is a hash of different args          | `MISMATCH` / `args_hash` | The executed call is not the one approved                            | What the different args were (only their hash is signed)                                    |
| `n2-verdict`           | `approval.verdict` is `denied`, but the call completed      | `MISMATCH` / `verdict`   | The call ran against a signed denial                                 | Whether the denial was delivered to the agent in time                                       |
| `n3-ordering`          | `approval.resolved_at` is 1 s after `invocation.started_at` | `MISMATCH` / `ordering`  | By the signers' own clocks, the approval came after the act          | Real-world time; the clocks are self-reported                                               |
| `n4-run`               | `approval.run_id` names another run                         | `MISMATCH` / `run`       | The approval belongs to a different run                              | Whether that other run exists                                                               |
| `n5-tampered-approval` | `approval.risk_level` changed 2 → 1 after signing           | `INVALID` / `signature`  | The approval bytes are not the bytes the approver key signed         | Anything about the relation; it is not evaluated on altered bytes                           |

`cases/control/deny-receipt.json` is the frozen deny-band receipt, an agent-signed refusal for a
separate task with no approval. It sits outside the join. Only its signature is checked
(`unjoined` in `expected.json`).

## Files

- `cases/<case>/*.json`: the artifacts. Their SHA-256 hashes are in `expected.json`.
- `expected.json`: the claim. Each case lists its verdict, every claim state, the failure codes, the decisive claim and its file hashes.
- `reader.py`, `test_reader.py`: the standalone Python reader and its mutation test.
- `mint-cases.mts`: the canonical minter for the negatives.
- `../../../scripts/__tests__/interop-approval-triad.test.ts`: the CI test. It reproduces `expected.json` with `@motebit/crypto` and checks the control against the frozen fixtures and every file against the minter.

## License

Apache-2.0. See [LICENSE](LICENSE).
