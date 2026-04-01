# @motebit/sdk Changelog

## 0.7.0

### Minor Changes

- 9b6a317: Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

  **Breaking:** The following exports have been removed from `@motebit/sdk`:
  - `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
  - `evaluateTrustTransition`, `composeDelegationTrust`
  - `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

  These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

  Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.

### Patch Changes

- Typed relay errors, storage parity, deletion policy, dead code cleanup.
  - Wire `SettlementError` and `FederationError` into relay paths (previously generic `Error`)
  - Pluggable logger in sync-engine encrypted adapter (replaces `console.warn`)
  - Scope knip to external deps (`@motebit/*` excluded from dead-code analysis)
  - Remove dead `@noble/ciphers` (Web Crypto API replaced it)
  - Remove dead code: `termWidth`, web error banner cluster (JS + CSS + HTML)
  - Encode deletion policy as architectural invariant in CLAUDE.md
  - Full storage parity: all surfaces wire complete `StorageAdapters` interface
  - Mark `verifyIdentityFile()` as deprecated in verify README
  - Override `@xmldom/xmldom` to >=0.8.12 (GHSA-wh4c-j3r5-mjhp)

- Updated dependencies [9b6a317]
  - @motebit/protocol@0.7.0

## 0.6.11

### Patch Changes

- [`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.10

### Patch Changes

- [`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.9

### Patch Changes

- [`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.8

### Patch Changes

- [`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.7

### Patch Changes

- [`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.6

### Patch Changes

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.5

### Patch Changes

- [`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.4

### Patch Changes

- [`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.3

### Patch Changes

- [`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71) Thanks [@hakimlabs](https://github.com/hakimlabs)! - Wrong passphrase: calm reset guide instead of jargon error

## 0.6.2

### Patch Changes

- [`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-launch passphrase: explain identity before prompting

## 0.6.1

### Patch Changes

- [`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-run UX: calm setup guide instead of raw API key error

## 0.6.0

### Minor Changes

- [`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12) Thanks [@hakimlabs](https://github.com/hakimlabs)! - v0.6.0: zero-dep verify, memory calibration, CLI republish
  - @motebit/sdk: Core types for the motebit protocol — state vectors, identity, memory, policy, tools, agent delegation, trust algebra, execution ledger, credentials. Zero deps, MIT
  - @motebit/verify: Verify any motebit artifact — identity files, execution receipts, verifiable credentials, presentations. One function, zero runtime deps (noble bundled), MIT
  - create-motebit: Scaffold signed identity and runnable agent projects. Key rotation with signed succession. --agent mode for MCP-served agents. Zero runtime deps, MIT
  - motebit: Operator console — REPL, daemon, MCP server mode, delegation, identity export/verify/rotate, credential management, budget/settlement. BSL-1.1 (converts to Apache-2.0)
  - Memory system: calibrated tagging prompt, consolidation dedup (REINFORCE no longer creates nodes), self-referential filter, valid_until display filtering across all surfaces
  - Empty-response guard: re-prompt when tag stripping yields no visible text after tool calls
  - Governor fix: candidate modifications (confidence cap, sensitivity reclassification) now respected in turn loop

## 0.5.3

### Patch Changes

- [`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.2

### Patch Changes

- [`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

All notable changes to `@motebit/sdk` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- Branded ID types: `AllocationId`, `SettlementId`, `ListingId`, `ProposalId` (join existing `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`)
- `PrecisionWeights` interface for active inference precision feedback
- `exploration_weight` field on `MarketConfig`
- `CollaborativePlanProposal`, `ProposalParticipant`, `ProposalStepCounter`, `ProposalResponse`, `CollaborativeReceipt` interfaces
- `ProposalStatus` and `ProposalResponseType` enums
- `assigned_motebit_id` on `PlanStep` and `SyncPlanStep`
- `proposal_id` and `collaborative` on `Plan` and `SyncPlan`
- 5 new `EventType` values: `ProposalCreated`, `ProposalAccepted`, `ProposalRejected`, `ProposalCountered`, `CollaborativeStepCompleted`
- `AgentServiceListing` and `AgentTrustRecord` interfaces for capability market
- `MemoryContent` type separated from `MemoryNode` for safe wire serialization
- `did` field on `VerifyResult` and `AgentCapabilities`
- `ReputationSnapshot` type for Beta-binomial smoothed reputation
- `CandidateProfile` and `TaskRequirements` types for market scoring
- Trust semiring algebra: `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`, `composeDelegationTrust`
- Canonical `TRUST_LEVEL_SCORES` mapping (single source of truth)
- W3C Verifiable Credentials types: `VerifiableCredential`, `VerifiablePresentation`, `CredentialProof`
- `ExecutionTimelineEntry` and `GoalExecutionManifest` types for execution ledger
- Budget allocation types: `BudgetAllocation`, `Settlement`
- `precisionContext` field on `ContextPack`

## [0.1.0] - 2026-03-08

### Added

- Core protocol types: `MotebitState`, `BehaviorCues`, `MemoryNode`, `EventLogEntry`, `PolicyDecision`, `RenderSpec`
- Identity types: `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`
- Agent delegation types: `ExecutionReceipt`, `DelegationToken`, `AgentTrustLevel`
- Tool, policy, and sync interfaces
- MIT licensed, zero dependencies
