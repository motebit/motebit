---
"@motebit/crypto": minor
"motebit": patch
---

Receipt producers never emit an unpaired UTF-16 surrogate (spec/execution-ledger-v1.md §11.4). `buildServiceReceipt`, the runtime's task handler, the CLI daemon's direct mode and `motebit smoke x402` repair the text they produce (U+FFFD, the same bytes a UTF-8 encoder writes, so a `result_hash` computed earlier still binds) before hashing; anything still malformed when it reaches the signer is refused, not repaired (see the signing-boundary changeset), and the `read_url`, `web_search`, `read_file` and `shell_exec` tools truncate their output without splitting a surrogate pair.
