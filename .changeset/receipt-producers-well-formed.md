---
"@motebit/crypto": minor
"motebit": patch
---

Receipt producers never emit an unpaired UTF-16 surrogate (spec/execution-ledger-v1.md §11.4). `signExecutionReceipt` replaces one in `result` with U+FFFD before signing — a `result_hash` computed with a UTF-8 encoder is unchanged by that, so the receipt verifies under strict hash binding; well-formed input signs byte-identically. `buildServiceReceipt`, the runtime's task handler and the CLI daemon's direct mode repair `result` before hashing, and the `read_url`, `web_search`, `read_file` and `shell_exec` tools truncate their output without splitting a surrogate pair.
