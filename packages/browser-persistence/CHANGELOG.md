# @motebit/browser-persistence

## 0.1.18

### Patch Changes

- 67e64ab: `IdbConversationStore.preload()` no longer holds a single multi-store IndexedDB transaction across two awaits — splits the conversation read and the active-conversation message read into two separate readonly transactions.

  The original implementation opened one transaction over both `conversations` and `conversation_messages`, awaited `idbRequest()` to load conversations, then issued a second `getAll` against the messages store inside the same transaction. IDB auto-commits a transaction when the current task has no pending requests, and `await` yields control to the microtask queue. Modern browsers preserve the transaction across that boundary in practice, but the spec doesn't guarantee it under stress (slow CPU, GC pause, very large query) and the failure mode is a hard `TransactionInactiveError` on the second op.

  Two cheap readonly transactions are deterministic across browsers and load conditions. Same observable behavior — both existing preload tests pass unchanged.

  Caught during a principal-engineer audit on 2026-04-18 prompted by an outside review that flagged the broader IDB layer. The "creature in a coma" framing of that review didn't hold — no active hangs in commits, tests, or user-visible bug reports — but `preload()` was the one genuinely brittle pattern in `packages/browser-persistence/src/`. The other 64 transaction call sites use the standard "fire-and-forget readwrite" IDB pattern, which auto-commits correctly and is not affected.

- Updated dependencies [699ba41]
- Updated dependencies [009f56e]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [1e07df5]
  - @motebit/sdk@1.0.0
  - @motebit/memory-graph@0.2.0
  - @motebit/planner@0.1.18
  - @motebit/privacy-layer@0.1.18
  - @motebit/core-identity@0.1.18
  - @motebit/event-log@0.1.18

## 0.1.17

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/sdk@0.8.0
  - @motebit/core-identity@0.1.17
  - @motebit/event-log@0.1.17
  - @motebit/memory-graph@0.1.17
  - @motebit/planner@0.1.17
  - @motebit/privacy-layer@0.1.17

## 0.1.16

### Patch Changes

- Updated dependencies [9b6a317]
- Updated dependencies
  - @motebit/sdk@0.7.0
  - @motebit/core-identity@0.1.16
  - @motebit/event-log@0.1.16
  - @motebit/memory-graph@0.1.16
  - @motebit/planner@0.1.16
  - @motebit/privacy-layer@0.1.16

## 0.1.15

### Patch Changes

- Updated dependencies [[`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17), [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9), [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842)]:
  - @motebit/sdk@0.6.11
  - @motebit/core-identity@0.1.15
  - @motebit/event-log@0.1.15
  - @motebit/memory-graph@0.1.15
  - @motebit/planner@0.1.15
  - @motebit/privacy-layer@0.1.15

## 0.1.14

### Patch Changes

- Updated dependencies [[`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470), [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61), [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440), [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f), [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f), [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0), [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f), [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05), [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7), [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052), [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26), [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72), [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17), [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9), [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647), [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440)]:
  - @motebit/sdk@0.6.10
  - @motebit/core-identity@0.1.14
  - @motebit/event-log@0.1.14
  - @motebit/memory-graph@0.1.14
  - @motebit/planner@0.1.14
  - @motebit/privacy-layer@0.1.14

## 0.1.13

### Patch Changes

- Updated dependencies [[`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e)]:
  - @motebit/sdk@0.6.9
  - @motebit/core-identity@0.1.13
  - @motebit/event-log@0.1.13
  - @motebit/memory-graph@0.1.13
  - @motebit/planner@0.1.13
  - @motebit/privacy-layer@0.1.13

## 0.1.12

### Patch Changes

- Updated dependencies [[`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4), [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80)]:
  - @motebit/sdk@0.6.8
  - @motebit/core-identity@0.1.12
  - @motebit/event-log@0.1.12
  - @motebit/memory-graph@0.1.12
  - @motebit/planner@0.1.12
  - @motebit/privacy-layer@0.1.12

## 0.1.11

### Patch Changes

- Updated dependencies [[`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389)]:
  - @motebit/sdk@0.6.7
  - @motebit/core-identity@0.1.11
  - @motebit/event-log@0.1.11
  - @motebit/memory-graph@0.1.11
  - @motebit/planner@0.1.11
  - @motebit/privacy-layer@0.1.11

## 0.1.10

### Patch Changes

- Updated dependencies [[`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7), [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7)]:
  - @motebit/sdk@0.6.6
  - @motebit/core-identity@0.1.10
  - @motebit/event-log@0.1.10
  - @motebit/memory-graph@0.1.10
  - @motebit/planner@0.1.10
  - @motebit/privacy-layer@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [[`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99)]:
  - @motebit/sdk@0.6.5
  - @motebit/core-identity@0.1.9
  - @motebit/event-log@0.1.9
  - @motebit/memory-graph@0.1.9
  - @motebit/planner@0.1.9
  - @motebit/privacy-layer@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [[`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2)]:
  - @motebit/sdk@0.6.4
  - @motebit/core-identity@0.1.8
  - @motebit/event-log@0.1.8
  - @motebit/memory-graph@0.1.8
  - @motebit/planner@0.1.8
  - @motebit/privacy-layer@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [[`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94), [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71)]:
  - @motebit/sdk@0.6.3
  - @motebit/core-identity@0.1.7
  - @motebit/event-log@0.1.7
  - @motebit/memory-graph@0.1.7
  - @motebit/planner@0.1.7
  - @motebit/privacy-layer@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [[`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0), [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb)]:
  - @motebit/sdk@0.6.2
  - @motebit/core-identity@0.1.6
  - @motebit/event-log@0.1.6
  - @motebit/memory-graph@0.1.6
  - @motebit/planner@0.1.6
  - @motebit/privacy-layer@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [[`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1), [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d)]:
  - @motebit/sdk@0.6.1
  - @motebit/core-identity@0.1.5
  - @motebit/event-log@0.1.5
  - @motebit/memory-graph@0.1.5
  - @motebit/planner@0.1.5
  - @motebit/privacy-layer@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [[`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12)]:
  - @motebit/sdk@0.6.0
  - @motebit/core-identity@0.1.4
  - @motebit/event-log@0.1.4
  - @motebit/memory-graph@0.1.4
  - @motebit/planner@0.1.4
  - @motebit/privacy-layer@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [[`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b), [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8), [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88), [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f), [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3), [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c), [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170), [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a), [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f), [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027), [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64), [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8), [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50), [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671), [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf), [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4), [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87), [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa), [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e), [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546), [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d), [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a), [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462), [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c), [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba), [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf), [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c), [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c), [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b)]:
  - @motebit/sdk@0.5.3
  - @motebit/core-identity@0.1.3
  - @motebit/event-log@0.1.3
  - @motebit/memory-graph@0.1.3
  - @motebit/planner@0.1.3
  - @motebit/privacy-layer@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [[`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806), [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc), [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64), [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0), [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8), [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1), [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de), [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879), [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c), [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719), [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2)]:
  - @motebit/sdk@0.5.2
  - @motebit/core-identity@0.1.2
  - @motebit/event-log@0.1.2
  - @motebit/memory-graph@0.1.2
  - @motebit/planner@0.1.2
  - @motebit/privacy-layer@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [[`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606), [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e), [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b), [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc), [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f), [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea), [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7), [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf), [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f), [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1), [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0)]:
  - @motebit/sdk@0.5.1
  - @motebit/core-identity@0.1.1
  - @motebit/event-log@0.1.1
  - @motebit/memory-graph@0.1.1
  - @motebit/planner@0.1.1
  - @motebit/privacy-layer@0.1.1
